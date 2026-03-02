# 日志清理机制

## 目录
- [1. 清理策略概览](#1-清理策略概览)
- [2. Delete 删除策略](#2-delete-删除策略)
- [3. Compact 压缩策略](#3-compact-压缩策略)
- [4. LogCleaner 实现](#4-logcleaner-实现)
- [5. 清理调度](#5-清理调度)
- [6. 实战配置](#6-实战配置)

---

## 1. 清理策略概览

### 1.1 清理策略类型

Kafka 支持两种日志清理策略：

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Delete (删除策略) - 默认                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 原理: 基于时间或大小删除旧数据                                 │
│                                                              │
│ 清理条件 (满足任一即删除):                                   │
│   - 基于时间: log.retention.hours=168 (7天)                │
│   - 基于大小: log.retention.bytes=-1 (无限制)              │
│   - 基于位置: log.retention.checkpoint.interval.ms          │
│                                                              │
│ 清理方式:                                                    │
│   - 整段删除: 删除过期的整个段                               │
│   - 部分删除: 删除段的前半部分 (不推荐，影响性能)           │
│                                                              │
│ 应用场景:                                                    │
│   - 日志收集                                                 │
│   - 事件流                                                   │
│   - 临时数据                                                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. Compact (压缩策略) - Key-based 压缩                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 原理: 保留每个 Key 的最新值，删除旧值                        │
│                                                              │
│ 清理过程:                                                    │
│   1. 扫描 Log，构建 Key -> Offset 映射                       │
│   2. 识别过期/重复的 Key                                     │
│   3. 重写 Log，只保留最新值                                  │
│   4. 替换旧 Log                                             │
│                                                              │
│ 应用场景:                                                    │
│   - Change Log (数据库 CDC)                                  │
│   - 状态存储                                                │
│   - KTable                                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 清理策略配置

```properties
# ========== 清理策略配置 ==========

# 清理策略类型: delete 或 compact
cleanup.policy=delete

# ========== Delete 策略配置 ==========

# 时间保留: 保留 7 天
log.retention.hours=168

# 大小保留: 无限制
log.retention.bytes=-1

# 检查点间隔: 5 分钟
log.retention.checkpoint.interval.ms=300000

# ========== Compact 策略配置 ==========

# 压缩策略
cleanup.policy=compact

# 脏数据比例: 50% 时触发清理
min.cleanable.dirty.ratio=0.5

# 最小压缩延迟: 数据至少存在 60 秒才能压缩
min.compaction.lag.ms=60000

# 最大压缩延迟: 数据最多存在 1 天必须压缩
max.compaction.lag.ms=86400000

# 删除记录保留: 压缩后的删除记录保留 1 天
delete.retention.ms=86400000
```

---

## 2. Delete 删除策略

### 2.1 删除策略实现

```scala
/**
 * Delete 策略清理
 *
 * 设计亮点：整段删除，高效且不影响性能
 */
class DeletePolicy(
    retentionMs: Long,
    retentionBytes: Long
) extends LogCleaningPolicy {

    /**
     * 识别需要删除的段
     */
    def deletableSegments(log: UnifiedLog): Seq[LogSegment] = {
        val segments = log.segments.values().asScala.toSeq

        // ========== 条件1: 基于时间删除 ==========
        val timeToDelete = if (retentionMs > 0) {
            val deleteTimestamp = time.milliseconds - retentionMs
            segments.filter { segment =>
                segment.maxTimestamp() < deleteTimestamp
            }
        } else {
            Seq.empty
        }

        // ========== 条件2: 基于大小删除 ==========
        val sizeToDelete = if (retentionBytes > 0) {
            var totalSize = 0L
            segments.reverse.flatMap { segment =>
                totalSize += segment.size()
                if (totalSize > retentionBytes) Some(segment)
                else None
            }
        } else {
            Seq.empty
        }

        // ========== 合并结果 ==========
        (timeToDelete ++ sizeToDelete).distinct
    }

    /**
     * 删除段
     */
    def deleteSegments(log: UnifiedLog, segments: Seq[LogSegment]): Unit = {
        segments.foreach { segment =>
            // ========== 步骤1: 从段列表移除 ==========
            log.segments.remove(segment.baseOffset)

            // ========== 步骤2: 异步删除文件 ==========
            asyncDeleteSegment(segment)
        }

        // ========== 步骤3: 更新日志元数据 ==========
        log.updateLogStartOffset()
    }
}
```

### 2.2 异步删除实现

```scala
/**
 * 异步删除段
 *
 * 设计：先重命名，后台删除
 */
private def asyncDeleteSegment(segment: LogSegment): Unit = {
    // ========== 步骤1: 重命名文件 ==========
    // 添加 .deleted 后缀，标记为待删除
    val logFile = segment.log.file()
    val indexFile = segment.index.file()
    val timeIndexFile = segment.timeIndex.file()

    logFile.renameTo(new File(logFile.getPath + ".deleted"))
    indexFile.renameTo(new File(indexFile.getPath + ".deleted"))
    timeIndexFile.renameTo(new File(timeIndexFile.getPath + ".deleted"))

    // ========== 步骤2: 加入删除队列 ==========
    // 后台线程会定期清理这些文件
    segmentsToDelete.put(segment, time.milliseconds())

    // ========== 步骤3: 关闭文件句柄 ==========
    segment.close()
}

/**
 * 后台删除线程
 */
private def startDeleteWorker(): Unit = {
    scheduler.scheduleAtFixedRate(
        new Runnable {
            def run(): Unit = {
                deleteExpiredSegments()
            }
        },
        0,
        1000,  // 每秒检查一次
        TimeUnit.MILLISECONDS
    )
}

/**
 * 删除过期的段文件
 */
private def deleteExpiredSegments(): Unit = {
    val now = time.milliseconds()

    segmentsToDelete.forEach { (segment, deleteTime) =>
        // 等待一段时间再删除，确保没有正在读取
        if (now - deleteTime > 60000) {  // 1分钟后删除
            try {
                // 删除文件
                segment.log.file().delete()
                segment.index.file().delete()
                segment.timeIndex.file().delete()

                // 从队列移除
                segmentsToDelete.remove(segment)
            } catch {
                case e: Exception =>
                    error(s"Error deleting segment ${segment.baseOffset}", e)
            }
        }
    }
}
```

### 2.3 保留策略配置

```properties
# ========== 时间保留 ==========

# 按小时: 168 小时 = 7 天
log.retention.hours=168

# 按分钟: 10080 分钟 = 7 天
log.retention.minutes=10080

# 按毫秒: 604800000 毫秒 = 7 天
log.retention.ms=604800000

# ========== 大小保留 ==========

# 每个分区最大大小: 100 GB
log.retention.bytes=107374182400

# 无限制: -1
log.retention.bytes=-1

# ========== 检查点配置 ==========

# 检查点间隔: 5 分钟
log.retention.checkpoint.interval.ms=300000

# ========== 实战配置示例 ==========

# 场景1: 日志收集 (7 天保留)
log.retention.hours=168
log.retention.bytes=-1

# 场景2: 临时数据 (1 天保留)
log.retention.hours=24
log.retention.bytes=-1

# 场景3: 长期存储 (30 天保留)
log.retention.hours=720
log.retention.bytes=-1

# 场景4: 限制大小 (最多 10 GB)
log.retention.hours=-1
log.retention.bytes=10737418240
```

---

## 3. Compact 压缩策略

### 3.1 压缩策略原理

```
压缩前:
┌─────────────────────────────────────────────────────────────┐
│ Log                                                         │
├─────────────────────────────────────────────────────────────┤
│ Key=A, Value=v1, Offset=0, Timestamp=T1                    │
│ Key=B, Value=v1, Offset=1, Timestamp=T2                    │
│ Key=A, Value=v2, Offset=2, Timestamp=T3  ← A 的最新值      │
│ Key=C, Value=v1, Offset=3, Timestamp=T4                    │
│ Key=B, Value=v2, Offset=4, Timestamp=T5  ← B 的最新值      │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘

压缩后:
┌─────────────────────────────────────────────────────────────┐
│ Cleaned Log                                                 │
├─────────────────────────────────────────────────────────────┤
│ Key=A, Value=v2, Offset=2, Timestamp=T3                    │
│ Key=B, Value=v2, Offset=4, Timestamp=T5                    │
│ Key=C, Value=v1, Offset=3, Timestamp=T4                    │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘

说明:
- 每个 Key 只保留最新的值
- 删除标记 (null value) 会被保留一段时间
- 删除标记用于通知消费者删除该 Key
```

### 3.2 压缩算法

```scala
/**
 * LogCleaner - 日志清理器
 *
 * 设计亮点:
 * 1. 异步清理: 不影响正常的读写
 * 2. 增量清理: 每次清理一部分
 * 3. 清理检查点: 记录清理进度
 */
class LogCleaner(
    config: CleanerConfig,
    logDirs: Seq[File],
    logs: Pool[TopicPartition, UnifiedLog]
) extends Logging {

    /**
     * 清理过程
     */
    def cleanFilthyLogs(): Unit = {
        // ========== 步骤1: 选择需要清理的 Log ==========
        val toClean = selectLogsToClean()

        toClean.foreach { case (tp, log) =>
            try {
                // ========== 步骤2: 执行清理 ==========
                cleanLog(tp, log)

                // ========== 步骤3: 记录检查点 ==========
                updateCleanedOffset(tp, log)
            } catch {
                case e: Exception =>
                    error(s"Error cleaning log $tp", e)
            }
        }
    }

    /**
     * 清理单个 Log
     */
    private def cleanLog(tp: TopicPartition, log: UnifiedLog): Unit = {
        // ========== 步骤1: 获取需要清理的段 ==========
        val dirtySegments = log.segments.values().asScala.filter { segment =>
            shouldClean(segment)
        }.toSeq

        dirtySegments.foreach { segment =>
            // ========== 步骤2: 构建映射表 ==========
            // Key -> Offset 映射，用于识别重复
            val offsetMap = buildOffsetMap(segment)

            // ========== 步骤3: 清理段 ==========
            cleanSegment(segment, offsetMap)
        }
    }

    /**
     * 清理单个段
     */
    private def cleanSegment(
        segment: LogSegment,
        offsetMap: OffsetMap
    ): Unit = {
        // ========== 步骤1: 读取段中的所有 Record ==========
        val records = segment.log.read(0, segment.log.size())

        // ========== 步骤2: 过滤 Record ==========
        // 只保留每个 Key 的最新版本
        val retainedRecords = filterRecords(records, offsetMap)

        // ========== 步骤3: 创建新段 ==========
        val newSegmentFile = new File(
            segment.log.file().getParent + "/" +
            segment.baseOffset() + ".cleaned"
        )

        // ========== 步骤4: 写入新段 ==========
        writeRecords(retainedRecords, newSegmentFile)

        // ========== 步骤5: 原子替换 ==========
        // 删除旧段，重命名新段
        segment.log.file().delete()
        newSegmentFile.renameTo(segment.log.file())

        // ========== 步骤6: 重建索引 ==========
        rebuildIndex(segment)
    }

    /**
     * 过滤记录
     */
    private def filterRecords(
        records: FileRecords,
        offsetMap: OffsetMap
    ): MemoryRecords = {
        val builder = MemoryRecords.builder()

        records.records().forEach { record =>
            val key = record.key()
            val offset = record.offset()

            // 检查是否是最新值
            if (offsetMap.latestOffset(key) == offset) {
                // 是最新值，保留
                builder.append(record)
            } else {
                // 是旧值，跳过
                logDebug(s"Skipping stale record at offset $offset")
            }
        }

        builder.build()
    }

    /**
     * 构建 Offset 映射
     */
    private def buildOffsetMap(segment: LogSegment): OffsetMap = {
        val offsetMap = new SkimpyOffsetMap(
            memory = config.offsetMapMemory,
            hashAlgorithm = config.hashAlgorithm
        )

        // 扫描所有记录，构建 Key -> Offset 映射
        segment.log.records().forEach { record =>
            val key = record.key()
            val offset = record.offset()

            // 保留最新的 offset
            offsetMap.put(key, offset)
        }

        offsetMap
    }
}
```

### 3.3 OffsetMap 实现

```scala
/**
 * SkimpyOffsetMap - 简洁的偏移量映射
 *
 * 设计:
 * - 使用哈希表存储 Key -> Offset
 * - 固定内存大小，使用 LRU 淘汰
 */
class SkimpyOffsetMap(
    memory: Int,
    hashAlgorithm: String
) extends OffsetMap {

    private val slots = new Array[(Array[Byte], Long)](numSlots)

    /**
     * 查找最新的 offset
     */
    def get(key: Array[Byte]): Long = {
        val slot = findSlot(key)
        slots(slot) match {
            case (k, offset) if Arrays.equals(k, key) => offset
            case _ => -1
        }
    }

    /**
     * 更新 offset
     */
    def put(key: Array[Byte], offset: Long): Unit = {
        val slot = findSlot(key)

        slots(slot) match {
            case (k, existingOffset) if Arrays.equals(k, key) =>
                // Key 存在，更新 offset
                slots(slot) = (key, offset)
            case _ =>
                // Key 不存在，插入
                slots(slot) = (key, offset)
        }
    }

    /**
     * 查找槽位
     */
    private def findSlot(key: Array[Byte]): Int = {
        var slot = hash(key) % numSlots

        // 线性探测
        while (slots(slot) != null &&
               !Arrays.equals(slots(slot)._1, key)) {
            slot = (slot + 1) % numSlots
        }

        slot
    }

    /**
     * 哈希函数
     */
    private def hash(key: Array[Byte]): Int = {
        // 使用 MurmurHash3
        hashAlgorithm.toLowerCase match {
            case "murmur2" => murmur2(key)
            case _ => key.hashCode()
        }
    }
}
```

---

## 4. LogCleaner 实现

### 4.1 LogCleaner 架构

```scala
/**
 * LogCleaner 架构
 *
 * 组件:
 * 1. CleanerThread: 清理线程
 * 2. Cleaner: 清理器
 * 3. OffsetMap: 偏移量映射
 * 4. CleanerConfig: 清理配置
 */
class LogCleaner(
    config: CleanerConfig,
    logDirs: Seq[File],
    logs: Pool[TopicPartition, UnifiedLog]
) extends Logging {

    // ========== 核心组件 ==========

    // 1. 清理线程池
    private val cleaners = (1 to config.numThreads).map { i =>
        new CleanerThread(i, this)
    }

    // 2. 清理检查点
    private val checkpoint = new CleanedCheckpoint(
        logDirs, config.checkpointFileName
    )

    // 3. 清理调度器
    private val scheduler = new KafkaScheduler(threads = 1)

    /**
     * 启动清理器
     */
    def startup(): Unit = {
        // ========== 步骤1: 加载检查点 ==========
        checkpoint.load()

        // ========== 步骤2: 启动清理线程 ==========
        cleaners.foreach(_.start())

        // ========== 步骤3: 启动调度器 ==========
        scheduler.startup()

        // ========== 步骤4: 定期调度清理 ==========
        scheduler.scheduleAtFixedRate(
          rate = 0,
          delayMs = config.initialDelay,
          periodMs = config.delayBetweenCleanMs,
          task = cleanFilthyLogs _
        )

        info("Started log cleaner")
    }

    /**
     * 清理日志
     */
    def cleanFilthyLogs(): Unit = {
        try {
            // ========== 步骤1: 选择需要清理的日志 ==========
            val toClean = selectLogsToClean()

            if (toClean.isEmpty) {
                // 没有需要清理的日志
                return
            }

            // ========== 步骤2: 分配给清理线程 ==========
            toClean.foreach { case (tp, log) =>
                val cleaner = selectCleaner()
                cleaner.enqueue(tp, log)
            }

            // ========== 步骤3: 等待清理完成 ==========
            cleaners.foreach(_.awaitCompletion())

            // ========== 步骤4: 保存检查点 ==========
            checkpoint.save()
        } catch {
            case e: Exception =>
            error("Error cleaning logs", e)
        }
    }
}
```

### 4.2 清理配置

```scala
/**
 * CleanerConfig - 清理器配置
 */
case class CleanerConfig(
    // ========== 线程配置 ==========
    numThreads: Int = 1,                    // 清理线程数
    dedupeBufferSize: Int = 128 * 1024 * 1024,  // 去重缓冲区大小

    // ========== 调度配置 ==========
    initialDelay: Long = 0,                 // 初始延迟
    delayBetweenCleanMs: Long = 60 * 1000,  // 清理间隔

    // ========== 清理配置 ==========
    minCompactionLagMs: Long = 0,           // 最小压缩延迟
    maxCompactionLagMs: Long = Long.MaxValue,  // 最大压缩延迟
    minCleanableRatio: Double = 0.5,        // 最小脏数据比例

    // ========== 其他配置 ==========
    ioBufferSize: Int = 1024 * 1024,        // I/O 缓冲区大小
    maxMessageSize: Int = 100 * 1024 * 1024,  // 最大消息大小
    hashAlgorithm: String = "murmur2"       // 哈希算法
)
```

---

## 5. 清理调度

### 5.1 清理触发条件

```scala
/**
 * 清理触发条件
 *
 * 满足以下任一条件即触发清理:
 */
class CleanTrigger {
    /**
     * 检查是否需要清理
     */
    def shouldClean(log: UnifiedLog): Boolean = {
        // ========== 条件1: 脏数据比例 ==========
        val dirtyRatio = log.dirtyRatio()
        if (dirtyRatio >= minCleanableRatio) {
            info(s"Triggering clean for $log with dirty ratio $dirtyRatio")
            return true
        }

        // ========== 条件2: 最大压缩延迟 ==========
        val oldestDirtyTimestamp = log.oldestDirtyTimestamp()
        val lag = time.milliseconds() - oldestDirtyTimestamp
        if (lag >= maxCompactionLagMs) {
            info(s"Triggering clean for $log with lag $lag ms")
            return true
        }

        false
    }
}
```

### 5.2 清理调度器

```scala
/**
 * 清理调度器
 *
 * 策略: 轮询检查，定期调度
 */
class CleanScheduler(
    cleaner: LogCleaner,
    intervalMs: Long = 60 * 1000  // 每分钟检查一次
) {
    private val scheduler = new KafkaScheduler(threads = 1)

    /**
     * 启动调度器
     */
    def startup(): Unit = {
        scheduler.startup()

        // 定期调度清理
        scheduler.scheduleAtFixedRate(
          rate = 0,
          delayMs = intervalMs,
          periodMs = intervalMs,
          task = () => cleaner.cleanFilthyLogs()
        )
    }

    /**
     * 停止调度器
     */
    def shutdown(): Unit = {
        scheduler.shutdown()
    }
}
```

---

## 6. 实战配置

### 6.1 Delete 策略配置

```properties
# ========== Delete 策略配置 ==========

# 基础配置
cleanup.policy=delete
log.retention.hours=168

# 检查点配置
log.retention.checkpoint.interval.ms=300000

# ========== 不同场景的配置 ==========

# 场景1: 日志收集 (7 天保留)
log.retention.hours=168
log.retention.bytes=-1

# 场景2: 实时数据 (1 天保留)
log.retention.hours=24
log.retention.bytes=-1

# 场景3: 存储受限 (10 GB 限制)
log.retention.hours=-1
log.retention.bytes=10737418240
```

### 6.2 Compact 策略配置

```properties
# ========== Compact 策略配置 ==========

# 基础配置
cleanup.policy=compact

# 脏数据比例
min.cleanable.dirty.ratio=0.5

# 压缩延迟
min.compaction.lag.ms=60000
max.compaction.lag.ms=86400000

# 删除记录保留
delete.retention.ms=86400000

# ========== 不同场景的配置 ==========

# 场景1: 状态存储 (快速压缩)
min.cleanable.dirty.ratio=0.3
min.compaction.lag.ms=1000
max.compaction.lag.ms=60000

# 场景2: Change Log (平衡)
min.cleanable.dirty.ratio=0.5
min.compaction.lag.ms=60000
max.compaction.lag.ms=3600000

# 场景3: KTable (慢速压缩)
min.cleanable.dirty.ratio=0.7
min.compaction.lag.ms=300000
max.compaction.lag.ms=86400000
```

### 6.3 清理监控

```bash
#!/bin/bash
# cleanup-monitor.sh - 清理监控脚本

echo "=== Cleanup Monitoring Report ==="

# 1. 查看清理策略
echo "1. Cleanup Policy:"
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name my-topic \
  --describe

# 2. 查看清理进度
echo "2. Cleanup Progress:"
kafka-log-dirs.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic-list my-topic

# 3. 查看磁盘使用
echo "3. Disk Usage:"
du -sh /data/kafka/logs/*/*

# 4. 查看段文件
echo "4. Segment Files:"
ls -lh /data/kafka/logs/my-topic-0/
```

---

## 7. 总结

### 7.1 清理策略对比

| 特性 | Delete | Compact |
|-----|--------|---------|
| **原理** | 删除旧数据 | 保留最新值 |
| **触发条件** | 时间/大小 | 脏数据比例 |
| **清理方式** | 删除段 | 重写段 |
| **适用场景** | 日志收集 | 状态存储 |
| **开销** | 低 | 高 |

### 7.2 配置建议

| 场景 | 策略 | 配置 |
|-----|------|------|
| **日志收集** | Delete | 7天保留 |
| **状态存储** | Compact | 50%脏数据触发 |
| **CDC** | Compact | 1分钟延迟 |
| **临时数据** | Delete | 1天保留 |

---

**下一章**: [07. 日志压缩](./07-log-compaction.md)
