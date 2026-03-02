# 日志索引机制

## 目录
- [1. 索引概述](#1-索引概述)
- [2. 偏移量索引 (.index)](#2-偏移量索引-index)
- [3. 时间索引 (.timeindex)](#3-时间索引-timeindex)
- [4. 索引查找算法](#4-索引查找算法)
- [5. 索引性能优化](#5-索引性能优化)
- [6. 实战操作](#6-实战操作)

---

## 1. 索引概述

### 1.1 为什么需要索引

**问题**：Kafka 日志文件可能达到 GB 级别，如何快速找到某个 offset 的消息？

**方案**：稀疏索引 + 顺序扫描

```
场景：查找 offset=1500 的消息

方案 1：全文件扫描
- 从头开始扫描整个文件
- 时间复杂度：O(N)
- 性能：慢（GB 级文件需要秒级）

方案 2：密集索引
- 为每条消息创建索引
- 索引大小 ≈ 数据文件大小
- 问题：内存无法全部加载

方案 3：稀疏索引（Kafka）
- 每隔一定字节数创建索引项
- 索引大小 ≈ 数据文件大小 / 4096
- 性能：快（毫秒级）
```

### 1.2 索引类型

Kafka 有两种索引：

| 索引类型 | 文件扩展名 | 用途 | 查找键 | 查找值 |
|---------|-----------|------|-------|-------|
| **偏移量索引** | .index | 根据 offset 查找消息位置 | offset (8 bytes) | position (8 bytes) |
| **时间索引** | .timeindex | 根据时间戳查找 offset | timestamp (8 bytes) | offset (8 bytes) |

### 1.3 索引文件结构

```
.index 文件结构:
┌────────────────────────────────────────────────────────┐
│ Header (40 bytes)                                      │
│ ├─ version (4 bytes)     │ 当前版本: 1                  │
│ ├─ append offset (8 bytes)│ 最后追加的 offset            │
│ └─ ...                                                  │
├────────────────────────────────────────────────────────┤
│ Entries (variable length)                               │
│ ┌───────────────────────────────────────────────┐      │
│ │ Entry 1: offset (4 bytes) | position (4 bytes)│      │
│ ├───────────────────────────────────────────────┤      │
│ │ Entry 2: offset (4 bytes) | position (4 bytes)│      │
│ ├───────────────────────────────────────────────┤      │
│ │ ...                                             │      │
│ └───────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────┘

.timeindex 文件结构:
┌────────────────────────────────────────────────────────┐
│ Header (40 bytes)                                      │
│ ├─ version (4 bytes)     │ 当前版本: 1                  │
│ ├─ append offset (8 bytes)│ 最后追加的 offset            │
│ └─ ...                                                  │
├────────────────────────────────────────────────────────┤
│ Entries (variable length)                               │
│ ┌───────────────────────────────────────────────┐      │
│ │ Entry 1: timestamp (8 bytes) | offset (8 bytes)│     │
│ ├───────────────────────────────────────────────┤      │
│ │ Entry 2: timestamp (8 bytes) | offset (8 bytes)│     │
│ ├───────────────────────────────────────────────┤      │
│ │ ...                                             │      │
│ └───────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────┘
```

---

## 2. 偏移量索引 (.index)

### 2.1 OffsetIndex 结构

```scala
/**
 * OffsetIndex - 偏移量稀疏索引
 *
 * 核心思想：
 * 1. 稀疏索引：不是每个消息都索引，节省空间
 * 2. 内存映射：使用 MMap 避免拷贝
 * 3. 有序存储：支持二分查找
 */
class OffsetIndex(
    file: File,                  // 索引文件
    baseOffset: Long,            // 基准偏移量
    maxIndexSize: Int            // 最大索引大小
) extends AbstractIndex[Long, Int] {

    // ========== 核心字段 ==========

    // 内存映射缓冲区
    private var mmap: MappedByteBuffer

    // 索引项数量
    @volatile private var _entries: Int = 0

    // ========== 索引项结构 ==========
    // 每个索引项占用 8 字节:
    // - offset (4 bytes): 相对偏移量
    // - position (4 bytes): 在 .log 文件中的物理位置

    /**
     * 索引文件格式:
     * ┌────────────────────────────────────────────┐
     * │ Entry 1 │ Entry 2 │ Entry 3 │ ... │ Entry N │
     * ├─────────┼─────────┼─────────┼─────┼─────────┤
     * │ offset  │ offset  │ offset  │     │ offset  │
     * │ position│ position│ position│     │ position│
     * │ (4+4)   │ (4+4)   │ (4+4)   │     │ (4+4)   │
     * └─────────┴─────────┴─────────┴─────┴─────────┘
     *
     * 示例 (假设索引间隔为 4KB):
     * ┌──────────┬──────────┐
     * │ offset   │ position │
     * ├──────────┼──────────┤
     * │ 100      │ 0        │ ← 第1个索引项
     * │ 200      │ 4096     │ ← 第2个索引项 (间隔 4KB)
     * │ 300      │ 8192     │ ← 第3个索引项
     * │ 400      │ 12288    │ ← 第4个索引项
     * │ ...      │ ...      │
     * └──────────┴──────────┘
     */
}
```

### 2.2 查找算法

```scala
/**
 * OffsetIndex.lookup() - 查找偏移量对应的物理位置
 *
 * 算法: 二分查找 + 顺序扫描
 */
def lookup(targetOffset: Long): OffsetPosition = {
    // ========== 步骤1: 边界检查 ==========
    lock.synchronized {
        if (entries == 0 || targetOffset < firstEntry.offset) {
            // 没有索引或目标小于第一个索引项
            return new OffsetPosition(baseOffset, 0)
        }
    }

    // ========== 步骤2: 二分查找索引 ==========
    // 找到最后一个 <= targetOffset 的索引项
    val slot = indexSlotFor(targetOffset, IndexSearchType.KEY)

    // ========== 步骤3: 获取索引项 ==========
    val entry = entry(slot)

    // ========== 步骤4: 返回结果 ==========
    // 返回的是索引项的位置，后续会从这个位置开始顺序扫描
    new OffsetPosition(baseOffset + entry.offset, entry.position)
}

/**
 * 二分查找实现 - lower_bound 算法
 */
private def indexSlotFor(target: Long, searchType: IndexSearchType): Int = {
    // 使用 C++ STL lower_bound 风格
    // 返回第一个 >= target 的位置
    // 如果所有元素都 < target，返回 entries

    val idx: MutableSortedIndex[Long, Int] = this
    import idx._

    // 二分查找
    var lo = 0
    var hi = entries - 1

    while (lo < hi) {
        val mid = (lo + hi + 1) >>> 1  // 向上取整

        // 读取索引项的 key
        val found = parseEntryKey(mid)

        if (compare(found, target) <= 0) {
            lo = mid
        } else {
            hi = mid - 1
        }
    }

    lo
}
```

### 2.3 相对偏移量设计

```scala
/**
 * 为什么使用相对偏移量？
 *
 * 问题: 如果直接存储绝对偏移量，需要 8 字节
 * 解决: 存储相对偏移量，只需要 4 字节
 *
 * 示例:
 * 段 baseOffset = 1000
 * 消息 offset = 1500
 * 相对 offset = 1500 - 1000 = 500
 *
 * 优势:
 * 1. 节省空间: 4 bytes vs 8 bytes
 * 2. 索引更小: 可以全部加载到内存
 */
class RelativeOffset {
    /**
     * 计算相对偏移量
     */
    def relativeOffset(offset: Long, baseOffset: Long): Int = {
        val relative = offset - baseOffset

        // 检查溢出
        require(relative >= 0 && relative <= Int.MaxValue,
            s"Relative offset $relative out of range [0, ${Int.MaxValue}]")

        relative.toInt
    }

    /**
     * 反算绝对偏移量
     */
    def absoluteOffset(relativeOffset: Int, baseOffset: Long): Long = {
        baseOffset + relativeOffset
    }
}
```

### 2.4 稀疏索引示例

```
场景：1GB 的段文件，索引间隔 4KB

数据文件:
┌─────────────────────────────────────────────────────────────┐
│ .log file (1GB = 262,144 个 4KB 块)                         │
│ 0KB    4KB    8KB    12KB   ...    1GB                      │
└─────────────────────────────────────────────────────────────┘

密集索引 (假设每条消息 1KB):
- 索引项数: 1,048,576
- 索引大小: 1,048,576 × 8 bytes = 8 MB
- 问题: 索引太大，无法全内存

稀疏索引 (Kafka):
- 索引项数: 262,144 (每隔 4KB 一个)
- 索引大小: 262,144 × 8 bytes = 2 MB
- 优势: 索引小，可全内存

查找 offset=50000 的过程:
1. 二分索引: 找到 49152 → 48 MB (O(log N) ≈ 18 次比较)
2. 从 position 48 MB 开始顺序扫描
3. 扫描 848 条消息找到 offset=50000
4. 总时间: < 1ms

性能:
- 二分查找: O(log N) ≈ 18 次比较
- 顺序扫描: O(distance) ≈ 848 条消息
- 总计: 快速查找
```

---

## 3. 时间索引 (.timeindex)

### 3.1 TimeIndex 结构

```scala
/**
 * TimeIndex - 时间戳索引
 *
 * 用途: 根据时间戳查找消息位置
 * 场景:
 * - 按时间消费 (offsetsForTime)
 * - 日志清理 (删除旧数据)
 */
class TimeIndex(
    file: File,
    baseOffset: Long,
    maxIndexSize: Int
) extends AbstractIndex[Long, Long] {

    /**
     * 索引项结构 (16 字节):
     * ┌──────────────┬──────────────┐
     * │ timestamp    │ offset       │
     * │ (8 bytes)    │ (8 bytes)    │
     * ├──────────────┼──────────────┤
     * │ 1640000000000│ 100          │
     * │ 1640000100000│ 200          │
     * │ 1640000200000│ 300          │
     * │ ...          │ ...          │
     * └──────────────┴──────────────┘
     */
    override def entrySize: Int = 16

    /**
     * 查找时间戳对应的偏移量
     */
    def lookup(targetTimestamp: Long): Long = {
        val slot = indexSlotFor(targetTimestamp, IndexSearchType.TIMESTAMP)

        if (slot == -1) {
            return baseOffset
        }

        entry(slot).offset + baseOffset
    }

    /**
     * 追加时间索引项
     */
    def append(timestamp: Long, offset: Long): Unit = {
        lock.synchronized {
            require(!isFull, "Attempt to append to full index")

            // 时间戳必须单调递增
            if (_entries > 0) {
                val lastEntry = entry(_entries - 1)
                require(timestamp > lastEntry.timestamp,
                    s"Timestamp $timestamp not greater than last timestamp ${lastEntry.timestamp}")
            }

            // 写入索引项
            mmap.putLong(timestamp)
            mmap.putLong(offset)

            _entries += 1
        }
    }
}
```

### 3.2 时间索引查找流程

```scala
/**
 * 根据时间戳查找 offset
 *
 * 使用场景:
 * 1. 消费者从某个时间点开始消费
 * 2. 删除某个时间点之前的数据
 */
def offsetsForTime(timestamp: Long): Seq[OffsetAndTimestamp] = {
    // ========== 步骤1: 找到包含该时间戳的段 ==========
    val segments = log.segments.values.iterator.dropWhile(_.maxTimestamp() < timestamp)

    if (!segments.hasNext) {
        return Seq.empty
    }

    // ========== 步骤2: 在段内查找 ==========
    val segment = segments.next()

    // 使用时间索引查找
    val offset = segment.timeIndex.lookup(timestamp)

    // ========== 步骤3: 验证时间戳 ==========
    // 可能需要顺序扫描找到精确的时间戳
    val fetchData = segment.read(offset, 1)

    if (fetchData.records.nonEmpty) {
        val firstRecord = fetchData.records.records().next()
        Seq(new OffsetAndTimestamp(offset, firstRecord.timestamp))
    } else {
        Seq.empty
    }
}
```

### 3.3 时间索引与时间截断

```scala
/**
 * 时间截断问题
 *
 * 问题: 时钟回拨或时间不同步可能导致时间戳不单调
 *
 * 解决: 使用 maxTimestampSoFar 维护单调性
 */
class TimeIndexTruncation {
    private var maxTimestampSoFar: Long = 0L

    /**
     * 处理时间戳
     */
    def maybeAppend(timestamp: Long, offset: Long): Unit = {
        if (timestamp > maxTimestampSoFar) {
            // 时间戳增加，可以追加索引
            timeIndex.append(timestamp, offset)
            maxTimestampSoFar = timestamp
        } else {
            // 时间戳回拨，不追加索引
            // 但记录仍然正常写入 .log 文件
            log.warn(s"Timestamp $timestamp is less than max timestamp $maxTimestampSoFar")
        }
    }
}
```

---

## 4. 索引查找算法

### 4.1 完整查找流程

```scala
/**
 * 完整的查找流程: offset -> FetchDataInfo
 *
 * 步骤:
 * 1. 找到包含目标 offset 的段
 * 2. 在段内使用索引查找
 * 3. 顺序扫描找到精确的 offset
 */
def read(startOffset: Long, maxSize: Int): FetchDataInfo = {
    // ========== 步骤1: 找到包含 offset 的段 ==========
    val segment = segments.floorSegment(startOffset)
    if (segment == null) {
        throw new OffsetOutOfRangeException(s"Offset $startOffset out of range")
    }

    // ========== 步骤2: 索引查找 ==========
    val offsetPosition = segment.index.lookup(startOffset)

    // ========== 步骤3: 顺序扫描 ==========
    // 从索引位置开始，顺序扫描找到目标 offset
    val fetchData = segment.read(startOffset, maxSize, offsetPosition.position)

    fetchData
}
```

### 4.2 二分查找详解

```scala
/**
 * 二分查找实现 - Java 风格
 */
object BinarySearch {

    /**
     * lower_bound: 找到第一个 >= target 的元素
     */
    def lowerBound(array: Array[Long], target: Long): Int = {
        var lo = 0
        var hi = array.length

        while (lo < hi) {
            val mid = (lo + hi) >>> 1  // 无符号右移，相当于除以2

            if (array(mid) < target) {
                lo = mid + 1
            } else {
                hi = mid
            }
        }

        lo
    }

    /**
     * upper_bound: 找到第一个 > target 的元素
     */
    def upperBound(array: Array[Long], target: Long): Int = {
        var lo = 0
        var hi = array.length

        while (lo < hi) {
            val mid = (lo + hi) >>> 1

            if (array(mid) <= target) {
                lo = mid + 1
            } else {
                hi = mid
            }
        }

        lo
    }

    /**
     * equal_range: 找到等于 target 的范围
     */
    def equalRange(array: Array[Long], target: Long): (Int, Int) = {
        val lower = lowerBound(array, target)
        val upper = upperBound(array, target)
        (lower, upper)
    }
}
```

### 4.3 顺序扫描优化

```scala
/**
 * 顺序扫描优化
 *
 * 问题: 索引是稀疏的，找到索引项后还需要顺序扫描
 * 优化: 使用更高效的数据结构和算法
 */
class SequentialScanOptimizer {
    /**
     * 扫描到目标 offset
     */
    def scanToOffset(records: FileRecords, startOffset: Long): LogOffsetPosition = {
        var position = 0
        var offset = baseOffset

        // 使用迭代器，避免创建中间对象
        val iterator = records.records().iterator()

        while (iterator.hasNext) {
            val record = iterator.next()

            if (record.offset == startOffset) {
                // 找到目标 offset
                return new LogOffsetPosition(startOffset, baseOffset, position)
            }

            // 更新 position
            position += record.sizeInBytes()
        }

        throw new OffsetOutOfRangeException(s"Offset $startOffset not found")
    }
}
```

---

## 5. 索引性能优化

### 5.1 索引间隔优化

```properties
# 索引间隔配置
log.index.interval.bytes=4096  # 默认 4KB
```

**权衡**:

```
小间隔 (1KB):
- 索引更密集，查找更快
- 索引文件更大 (8x)
- 内存占用更多

大间隔 (64KB):
- 索引更稀疏，查找稍慢
- 索引文件更小 (1/16)
- 内存占用更少

推荐: 4KB (默认)
- 平衡查找性能和索引大小
- 适合大多数场景
```

### 5.2 内存映射优化

```scala
/**
 * 内存映射 (MMap) 优势
 *
 * 传统方式: read() 系统调用
 * - 数据从内核空间拷贝到用户空间
 * - 每次 read() 都需要拷贝
 *
 * MMap 方式:
 * - 文件映射到虚拟内存
 * - 按需加载页面
 * - 零拷贝访问
 */
class MMapIndex {
    /**
     * 创建内存映射
     */
    private def mmapIndex(file: File): MappedByteBuffer = {
        val channel = new RandomAccessFile(file, "rw").getChannel()
        val idx = channel.map(
            FileChannel.MapMode.READ_WRITE,  // 读写模式
            0,                                // 起始位置
            file.length()                     // 映射大小
        )

        // 建议 JVM 优化
        idx.load()  // 预加载到内存

        idx
    }

    /**
     * 读取索引项
     */
    def parseEntry(slot: Int): IndexEntry = {
        // 直接访问内存，无需系统调用
        val position = slot * entrySize

        // 读取 offset (4 bytes)
        val offset = mmap.getInt(position)

        // 读取 position (4 bytes)
        val pos = mmap.getInt(position + 4)

        new IndexEntry(offset, pos)
    }
}
```

### 5.3 索引缓存优化

```scala
/**
 * 索引缓存优化
 *
 * 热点索引可以缓存在堆内存中
 */
class IndexCache(maxSize: Int) extends Logging {
    private val cache = new LRUCache[File, IndexBuffer](maxSize)

    /**
     * 获取索引
     */
    def getIndex(file: File): IndexBuffer = {
        // 尝试从缓存获取
        var idx = cache.get(file)

        if (idx == null) {
            // 缓存未命中，加载索引
            idx = loadIndex(file)
            cache.put(file, idx)
        }

        idx
    }

    /**
     * 加载索引
     */
    private def loadIndex(file: File): IndexBuffer = {
        val start = System.nanoTime()

        // 使用 MMap 加载
        val buffer = mmapFile(file)

        val duration = (System.nanoTime() - start) / 1000000.0
        logInfo(s"Loaded index ${file.getName} in ${duration}ms")

        new IndexBuffer(buffer)
    }
}
```

---

## 6. 实战操作

### 6.1 查看索引内容

```bash
# 1. 查看偏移量索引
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index \
  --print-data-log

# 输出示例:
# Index file: 00000000000000000000.index
# Entries: 1000
# Offset range: [0, 999]
# Position range: [0, 1048576]
#
# offset: 0, position: 0
# offset: 100, position: 4096
# offset: 200, position: 8192
# ...

# 2. 验证索引完整性
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index \
  --verify-index

# 3. 查看时间索引
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.timeindex \
  --print-data-log

# 4. 分析索引密度
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index | \
  grep "offset:" | \
  awk '{print $2}' | \
  awk '{diff=$1-prev; if(prev>0) print diff; prev=$1}' | \
  sort -n | \
  uniq -c | \
  head -10
```

### 6.2 索引重建

```bash
# 场景: 索引文件损坏，需要重建

# 1. 删除损坏的索引
rm /data/kafka/logs/my-topic-0/*.index
rm /data/kafka/logs/my-topic-0/*.timeindex

# 2. 重启 Broker
# Broker 会自动重建索引（扫描 .log 文件）

# 3. 验证索引
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index \
  --verify-index
```

### 6.3 索引性能测试

```bash
#!/bin/bash
# index-perf-test.sh - 索引性能测试

LOG_FILE="/data/kafka/logs/my-topic-0/00000000000000000000.log"
INDEX_FILE="/data/kafka/logs/my-topic-0/00000000000000000000.index"

echo "=== Index Performance Test ==="

# 1. 索引大小
echo "1. Index Size:"
stat -c%s "$INDEX_FILE" | awk '{print "  Size: " $1 " bytes (" $1/1024 " KB)"}'

# 2. 索引项数量
echo "2. Index Entries:"
count=$(kafka-dump-log.sh --files "$INDEX_FILE" --print-data-log 2>/dev/null | grep "offset:" | wc -l)
echo "  Entries: $count"

# 3. 平均索引间隔
echo "3. Average Index Interval:"
log_size=$(stat -c%s "$LOG_FILE")
interval=$((log_size / count))
echo "  Interval: $interval bytes"

# 4. 查找性能测试
echo "4. Lookup Performance:"
for i in {1..10}; do
  start=$(date +%s%N)
  # 模拟查找
  kafka-dump-log.sh --files "$INDEX_FILE" --verify-index > /dev/null 2>&1
  end=$(date +%s%N)
  duration=$(( (end - start) / 1000000 ))
  echo "  Run $i: ${duration}ms"
done
```

### 6.4 索引监控

```bash
#!/bin/bash
# index-monitor.sh - 索引监控脚本

LOG_DIR="/data/kafka/logs"

echo "=== Index Monitoring Report ==="
echo "Time: $(date)"
echo

# 1. 索引文件统计
echo "1. Index File Statistics:"
total_size=0
total_entries=0

for index in $(find $LOG_DIR -name "*.index"); do
  size=$(stat -c%s "$index" 2>/dev/null || stat -f%z "$index")
  entries=$(kafka-dump-log.sh --files "$index" --print-data-log 2>/dev/null | grep "offset:" | wc -l)

  total_size=$((total_size + size))
  total_entries=$((total_entries + entries))

  echo "  $(basename $index): size=$size, entries=$entries"
done

echo "  Total: size=$total_size bytes, entries=$total_entries"
echo

# 2. 索引密度分析
echo "2. Index Density:"
for topic in $(ls -d $LOG_DIR/*-* 2>/dev/null | head -5); do
  topic_name=$(basename "$topic")
  index_count=$(find "$topic" -name "*.index" | wc -l)
  echo "  $topic_name: $index_count indexes"
done
echo

# 3. 异常检测
echo "3. Anomaly Detection:"
for index in $(find $LOG_DIR -name "*.index"); do
  size=$(stat -c%s "$index" 2>/dev/null || stat -f%z "$index")
  if [ $size -gt 10485760 ]; then  # > 10MB
    echo "  WARNING: Large index file: $index ($size bytes)"
  fi
done
```

---

## 7. 总结

### 7.1 核心要点

| 特性 | 偏移量索引 | 时间索引 |
|-----|----------|---------|
| **查找键** | offset (4 bytes) | timestamp (8 bytes) |
| **查找值** | position (4 bytes) | offset (8 bytes) |
| **索引项大小** | 8 bytes | 16 bytes |
| **查找算法** | 二分查找 | 二分查找 |
| **用途** | 定位消息位置 | 按时间查找 |

### 7.2 设计亮点

1. **稀疏索引**: 不是每条消息都索引，节省空间
2. **相对偏移**: 使用相对偏移量，节省 4 字节
3. **内存映射**: 使用 MMap 实现零拷贝
4. **二分查找**: O(log N) 的查找复杂度
5. **独立索引**: 每个段独立索引，支持并发

### 7.3 最佳实践

| 场景 | 索引间隔配置 |
|-----|------------|
| **高吞吐** | 4096 (默认) |
| **低延迟查找** | 1024 |
| **大段文件** | 8192 |
| **内存受限** | 16384 |

---

**下一章**: [04. 日志追加流程](./04-log-append.md)
