# 日志压缩详解

## 目录
- [1. 压缩原理](#1-压缩原理)
- [2. 压缩算法](#2-压缩算法)
- [3. 压缩配置](#3-压缩配置)
- [4. 压缩监控](#4-压缩监控)
- [5. 压缩调优](#5-压缩调优)
- [6. 实战案例](#6-实战案例)

---

## 1. 压缩原理

### 1.1 什么是日志压缩

日志压缩（Log Compaction）是一种特殊的清理策略，它保证每个 Key 只保留最新的值。

```
传统删除策略（Delete）：
┌─────────────────────────────────────────────┐
│ 保留时间窗口内的所有数据                     │
│ 例如：保留最近 7 天的所有消息               │
└─────────────────────────────────────────────┘

压缩策略（Compact）：
┌─────────────────────────────────────────────┐
│ 保留每个 Key 的最新值                        │
│ 例如：Key=user:123 只保留最新的用户资料     │
└─────────────────────────────────────────────┘
```

### 1.2 压缩过程

```
压缩前:
┌──────────────────────────────────────────────────────────────┐
│ Offset  │ Key        │ Value    │ Timestamp                 │
├──────────────────────────────────────────────────────────────┤
│ 0       │ user:1     │ Alice    │ 2024-01-01T00:00:00       │
│ 1       │ user:2     │ Bob      │ 2024-01-01T00:01:00       │
│ 2       │ user:1     │ Alice V2 │ 2024-01-01T00:02:00  ← 最新│
│ 3       │ user:3     │ Charlie  │ 2024-01-01T00:03:00       │
│ 4       │ user:2     │ Bob V2   │ 2024-01-01T00:04:00  ← 最新│
└──────────────────────────────────────────────────────────────┘

压缩后:
┌──────────────────────────────────────────────────────────────┐
│ Offset  │ Key        │ Value    │ Timestamp                 │
├──────────────────────────────────────────────────────────────┤
│ 2       │ user:1     │ Alice V2 │ 2024-01-01T00:02:00       │
│ 4       │ user:2     │ Bob V2   │ 2024-01-01T00:04:00       │
│ 3       │ user:3     │ Charlie  │ 2024-01-01T00:03:00       │
└──────────────────────────────────────────────────────────────┘
         ↑ 每个用户只保留最新值
```

### 1.3 压缩与删除的区别

| 特性 | Delete | Compact |
|-----|--------|---------|
| **保留策略** | 时间窗口内所有数据 | 每个 Key 的最新值 |
| **数据模型** | Append-only Log | Key-Value Store |
| **清理方式** | 删除整个段 | 重写段，过滤旧值 |
| **空间使用** | 随时间线性增长 | 有界（Key 数量决定） |
| **适用场景** | 日志、事件流 | 状态存储、Change Log |
| **性能开销** | 低 | 高（需要扫描和重写） |

### 1.4 应用场景

```
适用场景:

1. 数据库 Change Data Capture (CDC)
   - 每行数据对应一个 Key
   - 只保留最新的状态
   - 删除标记 (tombstone) 表示行被删除

2. 状态存储 (KTable)
   - Kafka Streams 状态变更
   - 只保留最新的状态
   - 支持状态恢复

3. 用户配置
   - 用户 ID 作为 Key
   - 配置作为 Value
   - 只保留最新配置

4. 分布式配置中心
   - 配置项作为 Key
   - 配置值作为 Value
   - 实时同步最新配置

不适用场景:

1. 事件溯源 (Event Sourcing)
   - 需要保留所有事件
   - 不能压缩

2. 审计日志
   - 需要保留所有记录
   - 不能压缩

3. 临时数据
   - 使用 Delete 策略
   - 不需要压缩
```

---

## 2. 压缩算法

### 2.1 压缩算法概述

```scala
/**
 * 日志压缩算法
 *
 * 步骤:
 * 1. 扫描日志段，构建 Key -> Offset 映射
 * 2. 识别每个 Key 的最新 Offset
 * 3. 重写日志段，只保留最新值
 * 4. 原子替换旧段
 */
class LogCompactionAlgorithm {

    /**
     * 压缩日志段
     */
    def compact(segment: LogSegment): LogSegment = {
        // ========== 步骤1: 构建 Offset 映射 ==========
        val offsetMap = buildOffsetMap(segment)

        // ========== 步骤2: 扫描并过滤记录 ==========
        val retainedRecords = filterLatestRecords(segment, offsetMap)

        // ========== 步骤3: 创建新段 ==========
        val newSegment = createNewSegment(segment.baseOffset)

        // ========== 步骤4: 写入过滤后的记录 ==========
        newSegment.append(retainedRecords)

        // ========== 步骤5: 原子替换 ==========
        replaceSegment(segment, newSegment)

        newSegment
    }

    /**
     * 构建 Offset 映射
     */
    def buildOffsetMap(segment: LogSegment): OffsetMap = {
        val offsetMap = new SkimpyOffsetMap(
            memory = dedupeBufferSize,
            hashAlgorithm = "murmur2"
        )

        // 扫描所有记录，保留每个 Key 的最大 Offset
        segment.records().forEach { record =>
            val key = record.key()
            val offset = record.offset()

            // 保留最新的 offset
            if (offset > offsetMap.get(key)) {
                offsetMap.put(key, offset)
            }
        }

        offsetMap
    }

    /**
     * 过滤记录
     */
    def filterLatestRecords(
        segment: LogSegment,
        offsetMap: OffsetMap
    ): MemoryRecords = {
        val builder = MemoryRecords.builder()

        segment.records().forEach { record =>
            val key = record.key()
            val offset = record.offset()

            // 检查是否是最新值
            if (offsetMap.get(key) == offset) {
                // 是最新值，保留
                builder.append(record)
            } else {
                // 是旧值，跳过
                logDebug(s"Skipping stale record at offset $offset")
            }
        }

        builder.build()
    }
}
```

### 2.2 OffsetMap 实现

```scala
/**
 * SkimpyOffsetMap - 高效的偏移量映射
 *
 * 设计:
 * - 使用哈希表存储 Key -> Offset
 * - 固定内存大小，使用 LRU 淘汰
 * - 支持快速查找和更新
 */
class SkimpyOffsetMap(
    memory: Int,
    hashAlgorithm: String
) extends OffsetMap {

    // 计算槽位数量
    private val numSlots = memory / 16  // 每个槽位 16 字节
    private val slots = new Array[Slot](numSlots)

    /**
     * 槽位结构
     */
    case class Slot(
        key: Array[Byte],      // Key
        offset: Long           // 最新的 Offset
    )

    /**
     * 查找最新的 offset
     */
    def get(key: Array[Byte]): Long = {
        val slot = findSlot(key)
        if (slots(slot) != null && Arrays.equals(slots(slot).key, key)) {
            slots(slot).offset
        } else {
            -1
        }
    }

    /**
     * 更新 offset
     */
    def put(key: Array[Byte], offset: Long): Unit = {
        val slot = findSlot(key)

        if (slots(slot) != null && Arrays.equals(slots(slot).key, key)) {
            // Key 存在，更新 offset
            slots(slot) = Slot(key, offset)
        } else {
            // Key 不存在，插入
            slots(slot) = Slot(key, offset)
        }
    }

    /**
     * 查找槽位 (线性探测)
     */
    private def findSlot(key: Array[Byte]): Int = {
        var slot = hash(key) % numSlots

        // 线性探测
        while (slots(slot) != null &&
               !Arrays.equals(slots(slot).key, key)) {
            slot = (slot + 1) % numSlots
        }

        slot
    }

    /**
     * 哈希函数 (MurmurHash3)
     */
    private def hash(key: Array[Byte]): Int = {
        val data = new ByteArrayInputStream(key)
        val hash = MurmurHash3.hash128(data, 0, key.length, 0)
        (hash >>> 1).toInt  // 确保非负
    }
}
```

### 2.3 压缩策略

```scala
/**
 * 压缩策略
 *
 * 决定何时触发压缩，如何选择压缩的段
 */
class CompactionStrategy(
    minCleanableRatio: Double,     // 最小脏数据比例
    minCompactionLagMs: Long,      // 最小压缩延迟
    maxCompactionLagMs: Long       // 最大压缩延迟
) {

    /**
     * 检查是否需要压缩
     */
    def shouldCompact(log: UnifiedLog): Boolean = {
        // ========== 条件1: 脏数据比例 ==========
        val dirtyRatio = log.dirtyRatio()
        if (dirtyRatio >= minCleanableRatio) {
            info(s"Triggering compaction for $log with dirty ratio $dirtyRatio")
            return true
        }

        // ========== 条件2: 最大压缩延迟 ==========
        val oldestDirtyTimestamp = log.oldestDirtyTimestamp()
        val lag = time.milliseconds() - oldestDirtyTimestamp
        if (lag >= maxCompactionLagMs) {
            info(s"Triggering compaction for $log with lag $lag ms")
            return true
        }

        false
    }

    /**
     * 选择需要压缩的段
     */
    def selectSegments(log: UnifiedLog): Seq[LogSegment] = {
        val segments = log.segments.values().asScala.toSeq

        segments.filter { segment =>
            // ========== 条件1: 段已满（不再写入） ==========
            segment != log.activeSegment

            // ========== 条件2: 满足最小延迟 ==========
            val age = time.milliseconds() - segment.rollTime()
            age >= minCompactionLagMs

            // ========== 条件3: 段内是否有脏数据 ==========
            hasDirtyData(segment)
        }
    }
}
```

---

## 3. 压缩配置

### 3.1 核心配置参数

```properties
# ========== 压缩策略配置 ==========

# 启用压缩策略
cleanup.policy=compact

# 脏数据比例: 50% 时触发压缩
min.cleanable.dirty.ratio=0.5

# 最小压缩延迟: 数据至少存在 60 秒才能压缩
min.compaction.lag.ms=60000

# 最大压缩延迟: 数据最多存在 1 天必须压缩
max.compaction.lag.ms=86400000

# 删除记录保留: 压缩后的删除标记保留 1 天
delete.retention.ms=86400000

# ========== 清理器配置 ==========

# 清理线程数
log.cleaner.threads=4

# 清理器内存
log.cleaner.dedupe.buffer.size=134217728

# 清理器 I/O 缓冲区
log.cleaner.io.buffer.size=1048576

# 清理频率
log.cleaner.backoff.ms=15000
```

### 3.2 不同场景的配置

```properties
# ========== 场景1: 状态存储 (快速压缩) ==========
cleanup.policy=compact
min.cleanable.dirty.ratio=0.3
min.compaction.lag.ms=1000
max.compaction.lag.ms=60000
log.cleaner.threads=4

# ========== 场景2: Change Log (平衡) ==========
cleanup.policy=compact
min.cleanable.dirty.ratio=0.5
min.compaction.lag.ms=60000
max.compaction.lag.ms=3600000
log.cleaner.threads=2

# ========== 场景3: 用户配置 (慢速压缩) ==========
cleanup.policy=compact
min.cleanable.dirty.ratio=0.7
min.compaction.lag.ms=300000
max.compaction.lag.ms=86400000
log.cleaner.threads=1
```

### 3.3 压缩性能调优

```properties
# ========== 内存优化 ==========

# 增加去重缓冲区 (减少哈希冲突)
log.cleaner.dedupe.buffer.size=268435456

# 增加清理线程 (提高并发)
log.cleaner.threads=8

# ========== 性能优化 ==========

# 增加 I/O 缓冲区
log.cleaner.io.buffer.size=2097152

# 减少回退时间 (更积极的清理)
log.cleaner.backoff.ms=5000

# ========== 可靠性优化 ==========

# 保留删除标记更长时间 (确保消费者收到)
delete.retention.ms=86400000

# 启用压缩检查点
log.cleaner.enable.cleaner=true
```

---

## 4. 压缩监控

### 4.1 关键监控指标

```scala
/**
 * 压缩监控指标
 */
object CompactionMetrics {

    /**
     * 脏数据比例
     *
     * 计算方式: (log.endOffset - cleanOffset) / log.endOffset
     *
     * 意义:
     * - 脏数据比例高: 压缩不及时
     * - 脏数据比例低: 压缩过于频繁
     */
    def dirtyRatio(log: UnifiedLog): Double = {
        val endOffset = log.logEndOffset()
        val cleanOffset = log.firstDirtyOffset()
        (endOffset - cleanOffset).toDouble / endOffset
    }

    /**
     * 压缩延迟
     *
     * 计算方式: currentTimestamp - oldestDirtyTimestamp
     *
     * 意义:
     * - 延迟高: 压缩速度慢
     * - 延迟低: 压缩速度快
     */
    def compactionLag(log: UnifiedLog): Long = {
        time.milliseconds() - log.oldestDirtyTimestamp()
    }

    /**
     * 压缩速率
     *
     * 计算方式: cleanedBytes / time
     *
     * 意义:
     * - 速率高: 压缩性能好
     * - 速率低: 需要优化
     */
    def compactionRate(cleaner: LogCleaner): Double = {
        val cleanedBytes = cleaner.totalCleanedBytes()
        val elapsedTime = cleaner.totalElapsedTime()
        cleanedBytes.toDouble / elapsedTime
    }
}
```

### 4.2 监控脚本

```bash
#!/bin/bash
# compaction-monitor.sh - 压缩监控脚本

BROKER="localhost:9092"
TOPIC="compact-topic"

echo "=== Compaction Monitoring Report ==="

# 1. 查看压缩策略
echo "1. Compaction Policy:"
kafka-configs.sh \
  --bootstrap-server $BROKER \
  --entity-type topics \
  --entity-name $TOPIC \
  --describe | \
  grep "cleanup.policy"

# 2. 查看日志大小
echo "2. Log Size:"
kafka-log-dirs.sh \
  --bootstrap-server $BROKER \
  --describe \
  --topic-list $TOPIC | \
  grep -E "topic|size"

# 3. 计算脏数据比例
echo "3. Dirty Ratio:"
LOG_DIR="/data/kafka/logs"
for partition in $(ls -d ${LOG_DIR}/${TOPIC}-*); do
  start=$(cat ${partition}/log-start-offset-checkpoint 2>/dev/null | tail -1 | awk '{print $2}')
  end=$(ls -t ${partition}/*.log | head -1 | sed 's/.*\///' | sed 's/\.log//')

  if [ -n "$start" ] && [ -n "$end" ]; then
    ratio=$(echo "scale=2; ($end - $start) / $end" | bc)
    echo "  $(basename $partition): $ratio"
  fi
done

# 4. 查看清理线程状态
echo "4. Cleaner Threads:"
jstack $(ps aux | grep kafka | grep -v grep | awk '{print $2}') | \
  grep -A 5 "LogCleaner"

# 5. 监控磁盘使用
echo "5. Disk Usage:"
du -sh ${LOG_DIR}/${TOPIC}-*
```

---

## 5. 压缩调优

### 5.1 性能调优

```properties
# ========== 提高压缩速度 ==========

# 1. 增加清理线程
log.cleaner.threads=8

# 2. 增加去重缓冲区
log.cleaner.dedupe.buffer.size=268435456

# 3. 增加 I/O 缓冲区
log.cleaner.io.buffer.size=2097152

# ========== 减少压缩延迟 ==========

# 1. 降低脏数据比例阈值
min.cleanable.dirty.ratio=0.3

# 2. 减少最小压缩延迟
min.compaction.lag.ms=1000

# 3. 减少回退时间
log.cleaner.backoff.ms=5000

# ========== 降低 CPU 使用 ==========

# 1. 减少清理线程
log.cleaner.threads=2

# 2. 增加回退时间
log.cleaner.backoff.ms=30000

# 3. 提高脏数据比例阈值
min.cleanable.dirty.ratio=0.7
```

### 5.2 内存调优

```properties
# ========== 内存优化 ==========

# 1. 去重缓冲区大小
# 根据内存大小调整
log.cleaner.dedupe.buffer.size=134217728  # 128MB

# 2. I/O 缓冲区大小
log.cleaner.io.buffer.size=1048576  # 1MB

# 3. 最大消息大小
log.cleaner.io.max.bytes.per.second=1000000000  # 1GB/s

# ========== JVM 调优 ==========

# 堆内存
KAFKA_HEAP_OPTS="-Xmx8G -Xms8G"

# GC 策略
KAFKA_GC_LOG_OPTS="-XX:+UseG1GC -XX:MaxGCPauseMillis=20"
```

### 5.3 故障处理

```bash
# ========== 压缩失败处理 ==========

# 1. 查看压缩日志
tail -f /var/log/kafka/server.log | grep -i "clean"

# 2. 重置压缩检查点
rm /data/kafka/logs/cleaner-offset-checkpoint

# 3. 手动触发压缩
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name my-topic \
  --alter \
  --add-config min.cleanable.dirty.ratio=0.1

# 4. 暂停压缩
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name my-topic \
  --alter \
  --add-config min.cleanable.dirty.ratio=0.99
```

---

## 6. 实战案例

### 6.1 案例1: 用户配置中心

```properties
# 需求: 存储用户最新配置

# Topic 配置
bin/kafka-topics.sh \
  --create \
  --bootstrap-server localhost:9092 \
  --topic user-config \
  --partitions 10 \
  --replication-factor 3 \
  --config cleanup.policy=compact \
  --config min.cleanable.dirty.ratio=0.5 \
  --config min.compaction.lag.ms=60000

# Producer 配置
props.put("bootstrap.servers", "localhost:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("acks", "all");

// 发送配置
ProducerRecord<String, String> record =
    new ProducerRecord<>("user-config", "user:123", "{theme:dark}");
producer.send(record);
```

### 6.2 案例2: 数据库 CDC

```properties
# 需求: 同步数据库变更

# Topic 配置
bin/kafka-topics.sh \
  --create \
  --bootstrap-server localhost:9092 \
  --topic db-cdc \
  --partitions 10 \
  --replication-factor 3 \
  --config cleanup.policy=compact \
  --config min.cleanable.dirty.ratio=0.3 \
  --config min.compaction.lag.ms=1000

# Debezium 配置
{
  "database.hostname": "localhost",
  "database.port": "3306",
  "database.user": "debezium",
  "database.password": "dbz",
  "database.server.id": "184054",
  "database.server.name": "myapp",
  "database.whitelist": "mydb",
  "database.history.kafka.bootstrap.servers": "localhost:9092",
  "database.history.kafka.topic": "schema-changes.myapp"
}
```

### 6.3 案例3: 压缩性能优化

```bash
#!/bin/bash
# 压缩性能优化脚本

# 1. 监控当前压缩性能
echo "=== Current Compaction Performance ==="
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group compact-consumer

# 2. 调整配置
echo "=== Optimizing Configuration ==="
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name compact-topic \
  --alter \
  --add-config min.cleanable.dirty.ratio=0.3,min.compaction.lag.ms=1000

# 3. 增加清理线程
echo "=== Increasing Cleaner Threads ==="
# 编辑 server.properties
sed -i 's/log.cleaner.threads=.*/log.cleaner.threads=8/' /etc/kafka/server.properties

# 4. 重启 Kafka
systemctl restart kafka

# 5. 验证优化效果
echo "=== Verifying Optimization ==="
sleep 60
kafka-log-dirs.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic-list compact-topic
```

---

## 7. 总结

### 7.1 核心要点

| 特性 | 说明 |
|-----|------|
| **压缩原理** | 保留每个 Key 的最新值 |
| **触发条件** | 脏数据比例、延迟时间 |
| **压缩算法** | OffsetMap + 过滤 + 重写 |
| **性能优化** | 增加线程、增大缓冲区 |
| **适用场景** | 状态存储、CDC、配置中心 |

### 7.2 最佳实践

| 场景 | 脏数据比例 | 压缩延迟 | 清理线程 |
|-----|----------|---------|---------|
| **高频更新** | 0.3 | 1秒 | 8 |
| **中频更新** | 0.5 | 1分钟 | 4 |
| **低频更新** | 0.7 | 5分钟 | 2 |

### 7.3 常见问题

**Q: 压缩速度慢怎么办？**

A: 增加清理线程，增大去重缓冲区，降低脏数据比例阈值

**Q: 压缩占用 CPU 高怎么办？**

A: 减少清理线程，增加回退时间，提高脏数据比例阈值

**Q: 删除标记保留多久？**

A: 根据消费者性能调整，默认 1 天，确保消费者收到删除消息

---

**下一章**: [08. 日志操作命令](./08-log-operations.md)
