# 03. Kafka 消息格式演进

本文档深入分析 Kafka 消息格式的演进历史，了解 RecordBatch V2 的设计原理和优势。

## 目录
- [1. 消息格式概述](#1-消息格式概述)
- [2. Message v0 (Kafka 0.8)](#2-message-v0-kafka-08)
- [3. Message v1 (Kafka 0.10)](#3-message-v1-kafka-010)
- [4. RecordBatch v2 (Kafka 0.11)](#4-recordbatch-v2-kafka-011)
- [5. 变长字段编码](#5-变长字段编码)
- [6. 压缩机制](#6-压缩机制)

---

## 1. 消息格式概述

### 1.1 为什么需要消息格式

消息格式定义了 Kafka 中数据的存储和传输方式：

| 功能 | 说明 |
|-----|------|
| **数据序列化** | 将消息转换为字节流存储和传输 |
| **完整性校验** | CRC 校验保证数据不被损坏 |
| **版本兼容** | 支持格式演进和向后兼容 |
| **元数据携带** | 时间戳、Headers 等附加信息 |

### 1.2 消息格式演进历史

```
Kafka 消息格式演进时间线：

0.8.0 ───────────────────────────────────────────────────────────▶
  │
  ▼
Message v0 (Magic = 0)
- 基础消息格式
- CRC32 校验
- 无时间戳

0.10.0 ──────────────────────────────────────────────────────────▶
  │
  ▼
Message v1 (Magic = 1)
- 新增时间戳字段
- 支持 CreateTime/LogAppendTime

0.11.0 ──────────────────────────────────────────────────────────▶
  │
  ▼
RecordBatch v2 (Magic = 2)
- 批量消息设计
- 变长字段编码
- 幂等性支持 (PID + Sequence)
- 事务支持 (Producer Epoch)
- Headers 支持

2.4.0 ───────────────────────────────────────────────────────────▶
  │
  ▼
Flexible Versions
- 紧凑字段编码
- Tagged Fields
```

### 1.3 格式兼容性保证

```java
/**
 * 格式兼容性规则
 */
public class MessageFormat {

    /**
     * 向后兼容：新版本可以读取旧格式
     *
     * Broker 行为：
     * - 存储时保持原始格式
     * - 根据 Consumer 版本决定是否转换
     */

    /**
     * Magic Byte 识别
     */
    public static byte getMagicFromBuffer(ByteBuffer buffer) {
        // Magic byte 位于固定偏移位置
        return buffer.get(buffer.position() + 16);
    }

    /**
     * 版本升级策略：
     * 1. 客户端发送旧格式，Broker 存储旧格式
     * 2. 客户端发送新格式，Broker 存储新格式
     * 3. Consumer 请求时，Broker 按需转换
     */
}
```

---

## 2. Message v0 (Kafka 0.8)

### 2.1 字段结构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Message v0 Format                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Offset      │ INT64    │ 消息在分区中的偏移量                   │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Length      │ INT32    │ 消息体长度                             │
│  ────────────┼──────────┼───────────────────────────────────────│
│  CRC32       │ INT32    │ 消息体校验和                           │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Magic       │ INT8     │ 版本号 = 0                             │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Attributes  │ INT8     │ 压缩属性                               │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Key Length  │ INT32    │ Key 长度 (-1 表示 null)                │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Key         │ BYTES    │ Key 数据                               │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Value Length│ INT32    │ Value 长度 (-1 表示 null)              │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Value       │ BYTES    │ Value 数据                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

总开销：4 (length) + 4 (crc) + 1 (magic) + 1 (attributes) = 10 bytes
```

### 2.2 CRC32 校验

```java
/**
 * CRC32 校验计算
 */
public class Message {

    /**
     * 计算消息体的 CRC32
     */
    public long computeChecksum(byte[] buffer, int offset, int length) {
        CRC32 crc = new CRC32();
        // 从 Magic byte 后开始计算
        crc.update(buffer, offset + 8, length - 8);
        return crc.getValue();
    }

    /**
     * 校验消息完整性
     */
    public boolean isValid() {
        long expected = computeChecksum(buffer, offset, length);
        return expected == crc();
    }

    /**
     * CRC32 覆盖范围：
     * - 从 Magic byte 开始到消息结束
     * - 不包括 Offset 和 Length 字段
     */
}
```

### 2.3 Attributes 字段

```
Attributes 字段 (1 byte) 定义：

┌────────┬────────┬────────────────────────────────────────┐
│  Bits  │  Name  │  说明                                   │
├────────┼────────┼────────────────────────────────────────┤
│  0-2   │ COMPRESSION │ 压缩类型                        │
│        │        │   0 = 无压缩                            │
│        │        │   1 = GZIP                              │
│        │        │   2 = Snappy                            │
│        │        │   3 = LZ4                               │
│  3-7   │ UNUSED │ 保留                                   │
└────────┴────────┴────────────────────────────────────────┘
```

### 2.4 缺点分析

```
Message v0 的缺点：

1. 无时间戳
   - 无法按时间查询 Offset
   - 无法基于时间的保留策略

2. 固定字段长度
   - 即使 Key/Value 为空也占用 4 字节长度字段
   - 空间浪费

3. 单条消息存储
   - 每条消息独立校验
   - 压缩效率低

4. 无幂等性支持
   - 无法实现精确一次语义
```

---

## 3. Message v1 (Kafka 0.10)

### 3.1 新增字段

```
┌─────────────────────────────────────────────────────────────────┐
│                    Message v1 Format                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Offset      │ INT64    │ 消息在分区中的偏移量                   │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Length      │ INT32    │ 消息体长度                             │
│  ────────────┼──────────┼───────────────────────────────────────│
│  CRC32       │ INT32    │ 消息体校验和                           │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Magic       │ INT8     │ 版本号 = 1                             │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Attributes  │ INT8     │ 压缩属性 + 时间戳类型                  │
│  ────────────┼──────────┼───────────────────────────────────────│
│  TIMESTAMP   │ INT64    │ NEW: 时间戳 (毫秒)                     │
│  ────────────┼──────────┼───────────────────────────────────────│
│  Key Length  │ INT32    │ Key 长度                               │
│  Key         │ BYTES    │ Key 数据                               │
│  Value Length│ INT32    │ Value 长度                             │
│  Value       │ BYTES    │ Value 数据                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

新增：8 字节 Timestamp 字段
```

### 3.2 Timestamp 引入

```java
/**
 * 时间戳类型
 */
public enum TimestampType {
    CREATE_TIME(0),      // 生产者创建时间
    LOG_APPEND_TIME(1);  // Broker 追加时间

    public final int id;

    TimestampType(int id) {
        this.id = id;
    }
}

/**
 * Attributes 字段更新 (v1)
 */
public class MessageAttributes {

    /**
     * Attributes 位定义：
     *
     * Bit 0-2: 压缩类型
     *   0 = 无压缩
     *   1 = GZIP
     *   2 = Snappy
     *   3 = LZ4
     *
     * Bit 3: 时间戳类型
     *   0 = CREATE_TIME
     *   1 = LOG_APPEND_TIME
     *
     * Bit 4-7: 保留
     */

    public static TimestampType timestampType(byte attributes) {
        return ((attributes & 0x08) == 0) ?
            TimestampType.CREATE_TIME : TimestampType.LOG_APPEND_TIME;
    }

    public static byte setTimestampType(byte attributes, TimestampType type) {
        if (type == TimestampType.LOG_APPEND_TIME) {
            return (byte) (attributes | 0x08);
        } else {
            return (byte) (attributes & ~0x08);
        }
    }
}
```

### 3.3 Magic Byte = 1

```java
/**
 * Magic Byte 识别格式版本
 */
public class MessageFormat {

    /**
     * 解析消息并返回版本
     */
    public static MessageVersion parse(ByteBuffer buffer) {
        byte magic = buffer.get(buffer.position() + 16);

        switch (magic) {
            case 0:
                return MessageVersion.V0;
            case 1:
                return MessageVersion.V1;
            case 2:
                return MessageVersion.V2;
            default:
                throw new UnknownMessageFormatException(
                    "Unknown magic byte: " + magic
                );
        }
    }
}
```

### 3.4 与 v0 的对比

| 特性 | v0 | v1 |
|-----|----|----|
| Magic | 0 | 1 |
| 时间戳 | 无 | 有 |
| 大小 | N | N + 8 |
| 时间戳类型 | - | CreateTime/LogAppendTime |
| 兼容性 | - | 向后兼容 v0 |

---

## 4. RecordBatch v2 (Kafka 0.11)

### 4.1 批量消息设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    RecordBatch v2 Format                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Base Offset     │ INT64  │ 批次中第一条消息的偏移量             │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Batch Length    │ INT32  │ 批次长度（从 Partition Leader      │
│                  │        │ Epoch 开始到结束）                   │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Partition       │ INT32  │ 分区 Leader Epoch                    │
│  Leader Epoch    │        │ （用于副本同步校验）                  │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Magic           │ INT8   │ = 2                                  │
│  ────────────────┼────────┼─────────────────────────────────────│
│  CRC32           │ INT32  │ 从 Attributes 到 Records 结束        │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Attributes      │ INT16  │ 压缩类型 + 时间戳类型 + 事务/控制标志 │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Last Offset     │ INT32  │ 批次中最后一条消息相对于              │
│  Delta           │        │ Base Offset 的偏移                    │
│  ────────────────┼────────┼─────────────────────────────────────│
│  First Timestamp │ INT64  │ 批次中第一条消息的时间戳              │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Max Timestamp   │ INT64  │ 批次中最后一条消息的时间戳            │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Producer ID     │ INT64  │ 生产者 ID（幂等性/事务）              │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Producer Epoch  │ INT16  │ 生产者 Epoch（防止僵尸生产者）        │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Base Sequence   │ INT32  │ 批次基础序列号（幂等性去重）          │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Records Count   │ INT32  │ 批次中消息数量                        │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Records         │ ARRAY  │ 消息记录数组                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

批次开销：61 字节固定头 + 变长 Records
```

### 4.2 RecordBatch 头结构

```java
/**
 * RecordBatch 接口定义
 */
public interface RecordBatch extends Iterable<Record> {

    // 固定字段偏移量
    int BASE_OFFSET_LENGTH = 8;
    int LENGTH_LENGTH = 4;
    int PARTITION_LEADER_EPOCH_LENGTH = 4;
    int MAGIC_LENGTH = 1;
    int CRC_LENGTH = 4;
    int ATTRIBUTES_LENGTH = 2;
    int LAST_OFFSET_DELTA_LENGTH = 4;
    int FIRST_TIMESTAMP_LENGTH = 8;
    int MAX_TIMESTAMP_LENGTH = 8;
    int PRODUCER_ID_LENGTH = 8;
    int PRODUCER_EPOCH_LENGTH = 2;
    int BASE_SEQUENCE_LENGTH = 4;
    int RECORDS_COUNT_LENGTH = 4;

    // 固定头大小 = 61 字节
    int LOG_OVERHEAD = BASE_OFFSET_LENGTH + LENGTH_LENGTH;
    int RECORD_BATCH_OVERHEAD = LOG_OVERHEAD +
        PARTITION_LEADER_EPOCH_LENGTH +
        MAGIC_LENGTH +
        CRC_LENGTH +
        ATTRIBUTES_LENGTH +
        LAST_OFFSET_DELTA_LENGTH +
        FIRST_TIMESTAMP_LENGTH +
        MAX_TIMESTAMP_LENGTH +
        PRODUCER_ID_LENGTH +
        PRODUCER_EPOCH_LENGTH +
        BASE_SEQUENCE_LENGTH +
        RECORDS_COUNT_LENGTH;

    long baseOffset();
    int partitionLeaderEpoch();
    byte magic();
    long crc();
    short attributes();
    int lastOffsetDelta();
    long firstTimestamp();
    long maxTimestamp();
    long producerId();
    short producerEpoch();
    int baseSequence();
    int count();
}
```

### 4.3 Record 结构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Record Format (V2)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Length           │ Varint │ 记录总长度（不包括自身）            │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Attributes       │ Varint │ 属性（目前未使用，值为 0）           │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Timestamp Delta  │ Varlong│ 相对于 First Timestamp 的增量        │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Offset Delta     │ Varint │ 相对于 Base Offset 的增量            │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Key Length       │ Varint │ Key 长度 (-1 表示 null)              │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Key              │ BYTES  │ Key 数据                             │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Value Length     │ Varint │ Value 长度 (-1 表示 null)            │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Value            │ BYTES  │ Value 数据                           │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Headers Count    │ Varint │ Header 数量                          │
│  ────────────────┼────────┼─────────────────────────────────────│
│  Headers          │ ARRAY  │ 消息头数组                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```java
/**
 * Record 接口
 */
public interface Record {

    // 最大记录开销（用于预分配缓冲区）
    int MAX_RECORD_OVERHEAD = 21;

    /**
     * Record 字段使用变长编码：
     * - Length: varint (1-5 bytes)
     * - Attributes: varint (1 byte)
     * - Timestamp Delta: varlong (1-10 bytes)
     * - Offset Delta: varint (1-5 bytes)
     * - Key Length: varint (1-5 bytes)
     * - Value Length: varint (1-5 bytes)
     * - Headers Count: varint (1-5 bytes)
     */

    int sizeInBytes();
    byte attributes();
    long timestamp();
    long offset();
    int keySize();
    ByteBuffer key();
    int valueSize();
    ByteBuffer value();
    List<Header> headers();
}
```

### 4.4 Magic Byte = 2

```java
/**
 * RecordBatch 特性（Magic = 2）
 */
public class RecordBatchV2 {

    public static final byte CURRENT_MAGIC_VALUE = 2;

    /**
     * Attributes 字段定义（16 bits）：
     *
     * Bits 0-2: 压缩类型
     *   0 = NONE
     *   1 = GZIP
     *   2 = SNAPPY
     *   3 = LZ4
     *   4 = ZSTD (Kafka 2.1+)
     *
     * Bit 3: 时间戳类型
     *   0 = CREATE_TIME
     *   1 = LOG_APPEND_TIME
     *
     * Bit 4: 是否是事务批次
     *   0 = 非事务
     *   1 = 事务批次
     *
     * Bit 5: 是否是控制消息
     *   0 = 普通消息
     *   1 = 控制消息（事务标记）
     *
     * Bits 6-15: 保留
     */

    public static boolean isTransactional(short attributes) {
        return (attributes & TRANSACTIONAL_FLAG_MASK) != 0;
    }

    public static boolean isControlBatch(short attributes) {
        return (attributes & CONTROL_FLAG_MASK) != 0;
    }
}
```

### 4.5 幂等性支持 (PID + Sequence)

```
┌─────────────────────────────────────────────────────────────────┐
│                    幂等性实现机制                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Producer ──────▶ Broker                                        │
│     │              │                                             │
│     │  RecordBatch │                                            │
│     │  {                                                          │
│     │    producerId: 1001,      ← 生产者唯一标识                 │
│     │    producerEpoch: 0,      ← 生产者世代                     │
│     │    baseSequence: 5,       ← 批次起始序列号                 │
│     │    records: [                                            │
│     │      {offsetDelta: 0, sequence: 5},                       │
│     │      {offsetDelta: 1, sequence: 6},                       │
│     │      {offsetDelta: 2, sequence: 7}                        │
│     │    ]                                                       │
│     │  }                                                          │
│     │              │                                             │
│     │              ▼                                             │
│     │         ┌─────────────────────┐                           │
│     │         │ 重复检测            │                           │
│     │         │ (PID + Sequence)    │                           │
│     │         └─────────────────────┘                           │
│     │              │                                             │
│     │              ▼                                             │
│     │         ┌─────────────────────┐                           │
│     │         │ Sequence 连续？     │                           │
│     │         │ 是：追加            │                           │
│     │         │ 否：丢弃/报错       │                           │
│     │         └─────────────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```java
/**
 * Broker 端幂等性校验
 */
public class ProducerStateEntry {

    private final long producerId;
    private short producerEpoch;
    private int lastSequence;
    private long lastOffset;

    /**
     * 检查序列号是否连续
     */
    public boolean isDuplicate(int sequence) {
        return sequence <= lastSequence;
    }

    public boolean isValidSequence(int sequence) {
        return sequence == lastSequence + 1;
    }

    /**
     * 更新生产者状态
     */
    public void update(int sequence, long offset) {
        this.lastSequence = sequence;
        this.lastOffset = offset;
    }
}
```

### 4.6 事务支持 (Producer Epoch)

```
┌─────────────────────────────────────────────────────────────────┐
│                    事务支持机制                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  RecordBatch 事务标记：                                          │
│                                                                 │
│  Attributes 字段：                                               │
│  ┌─────────────┬──────────────────────────────────────────────┐ │
│  │ Bit 4       │ TRANSACTIONAL_FLAG                           │ │
│  │             │ 0 = 非事务批次                                │ │
│  │             │ 1 = 属于某个事务                              │ │
│  ├─────────────┼──────────────────────────────────────────────┤ │
│  │ Bit 5       │ CONTROL_FLAG                                 │ │
│  │             │ 0 = 普通消息                                  │ │
│  │             │ 1 = 控制消息（事务提交/中止标记）              │ │
│  └─────────────┴──────────────────────────────────────────────┘ │
│                                                                 │
│  事务流程：                                                       │
│                                                                 │
│  1. 生产者发送事务消息：                                          │
│     RecordBatch {                                                 │
│       transactionalId: "txn-1",                                   │
│       producerId: 1001,                                           │
│       producerEpoch: 0,                                           │
│       attributes: TRANSACTIONAL_FLAG | ...                        │
│     }                                                             │
│                                                                 │
│  2. Broker 存储，但不立即对消费者可见                             │
│     (LSO - Last Stable Offset 之前的数据才对消费者可见)           │
│                                                                 │
│  3. 事务提交：                                                    │
│     ControlBatch {                                                │
│       attributes: CONTROL_FLAG | ...                              │
│       commit: true                                                │
│     }                                                             │
│                                                                 │
│  4. 消费者可见性：                                                │
│     isolation.level=read_committed 只读取已提交消息               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 变长字段编码

### 5.1 Varint 编码

```java
/**
 * Varint 编码（Variable-length integer）
 *
 * 原理：使用最高位表示是否还有后续字节
 * 值越小，占用字节越少
 */
public class Varint {

    /**
     * 写入 Varint
     */
    public static void write(ByteBuffer buffer, int value) {
        // ZigZag 编码：将有符号数映射到无符号数
        // 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, ...
        int encoded = (value << 1) ^ (value >> 31);

        while ((encoded & ~0x7F) != 0) {
            buffer.put((byte) ((encoded & 0x7F) | 0x80));
            encoded >>>= 7;
        }
        buffer.put((byte) encoded);
    }

    /**
     * 读取 Varint
     */
    public static int read(ByteBuffer buffer) {
        int result = 0;
        int shift = 0;
        byte b;

        do {
            b = buffer.get();
            result |= (b & 0x7F) << shift;
            shift += 7;
        } while ((b & 0x80) != 0);

        // ZigZag 解码
        return (result >>> 1) ^ -(result & 1);
    }

    /**
     * 示例：
     *
     * Value    Encoded    Bytes
     * ───────────────────────────
     * 0        0x00       1
     * 1        0x02       1
     * -1       0x01       1
     * 63       0x7E       1
     * 64       0x80 0x01  2
     * 127      0xFE 0x01  2
     * 128      0x80 0x02  2
     * 16383    0xFE 0xFF 0x03  3
     */
}
```

### 5.2 Varlong 编码

```java
/**
 * Varlong 编码（64位变长整数）
 */
public class Varlong {

    public static void write(ByteBuffer buffer, long value) {
        // ZigZag 编码
        long encoded = (value << 1) ^ (value >> 63);

        while ((encoded & ~0x7FL) != 0) {
            buffer.put((byte) ((encoded & 0x7F) | 0x80));
            encoded >>>= 7;
        }
        buffer.put((byte) encoded);
    }

    public static long read(ByteBuffer buffer) {
        long result = 0;
        int shift = 0;
        byte b;

        do {
            b = buffer.get();
            result |= (long) (b & 0x7F) << shift;
            shift += 7;
        } while ((b & 0x80) != 0);

        return (result >>> 1) ^ -(result & 1);
    }
}
```

### 5.3 CompactString

```java
/**
 * 紧凑字符串编码
 */
public class CompactString {

    /**
     * 编码格式：
     * - 长度使用 Varint 编码
     * - 长度值 = N + 1 (0 表示 null, 1 表示空字符串)
     * - 后接 UTF-8 字节
     */
    public static void write(ByteBuffer buffer, String str) {
        if (str == null) {
            Varint.write(buffer, 0);
        } else {
            byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
            Varint.write(buffer, bytes.length + 1);
            buffer.put(bytes);
        }
    }

    public static String read(ByteBuffer buffer) {
        int length = Varint.read(buffer);
        if (length == 0) {
            return null;
        }
        length--;  // 减去 1
        byte[] bytes = new byte[length];
        buffer.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /**
     * 对比：
     *
     * 传统 String (v0/v1):
     *   长度: 2 bytes
     *   "a" -> 00 01 61 (3 bytes)
     *
     * Compact String (v2):
     *   长度: varint
     *   "a" -> 02 61 (2 bytes)
     */
}
```

### 5.4 CompactArray

```java
/**
 * 紧凑数组编码
 */
public class CompactArray {

    /**
     * 编码格式：
     * - 元素数量使用 Varint 编码
     * - 数量值 = N + 1 (0 表示 null)
     * - 后接元素（每个元素使用紧凑编码）
     */
    public static <T> void write(ByteBuffer buffer,
                                  List<T> array,
                                  Consumer<T> writer) {
        if (array == null) {
            Varint.write(buffer, 0);
        } else {
            Varint.write(buffer, array.size() + 1);
            for (T item : array) {
                writer.accept(item);
            }
        }
    }

    public static <T> List<T> read(ByteBuffer buffer,
                                  Supplier<T> reader) {
        int count = Varint.read(buffer);
        if (count == 0) {
            return null;
        }
        count--;

        List<T> result = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            result.add(reader.get());
        }
        return result;
    }
}
```

---

## 6. 压缩机制

### 6.1 压缩时机

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kafka 压缩层级                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Producer 端压缩：                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 多条消息组成 RecordBatch                                │   │
│  │ 2. 对整个 RecordBatch 进行压缩                              │   │
│  │ 3. 压缩后的数据作为一条 "消息" 发送到 Broker                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Broker 端处理：                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 接收压缩后的 RecordBatch                                │   │
│  │ 2. 校验但不解压（如果 compression.type 匹配）                │   │
│  │ 3. 直接存储压缩数据                                         │   │
│  │ 4. 转发给其他 Broker 时保持压缩                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Consumer 端解压：                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 接收压缩的 RecordBatch                                  │   │
│  │ 2. 根据 attributes 识别压缩类型                             │   │
│  │ 3. 解压后解析 Records                                       │   │
│  │ 4. 返回给应用层                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 压缩算法支持

```java
/**
 * 压缩类型枚举
 */
public enum CompressionType {

    NONE(0, "none", 1.0f) {
        @Override
        public OutputStream wrapForOutput(OutputStream out) {
            return out;
        }
        @Override
        public InputStream wrapForInput(InputStream in) {
            return in;
        }
    },

    GZIP(1, "gzip", 1.0f) {
        @Override
        public OutputStream wrapForOutput(OutputStream out) throws IOException {
            return new GZIPOutputStream(out);
        }
        @Override
        public InputStream wrapForInput(InputStream in) throws IOException {
            return new GZIPInputStream(in);
        }
    },

    SNAPPY(2, "snappy", 1.0f) {
        // 使用 Snappy 库
    },

    LZ4(3, "lz4", 1.0f) {
        // 使用 LZ4 库
    },

    ZSTD(4, "zstd", 1.0f) {  // Kafka 2.1+
        // 使用 Zstd 库
    };

    public final int id;
    public final String name;
    public final float rate;

    CompressionType(int id, String name, float rate) {
        this.id = id;
        this.name = name;
        this.rate = rate;
    }

    public abstract OutputStream wrapForOutput(OutputStream out) throws IOException;
    public abstract InputStream wrapForInput(InputStream in) throws IOException;
}
```

### 6.3 RecordBatch 级别的压缩

```java
/**
 * RecordBatch 压缩实现
 */
public class MemoryRecordsBuilder {

    private final CompressionType compressionType;
    private ByteBufferOutputStream bufferStream;
    private OutputStream compressionStream;

    /**
     * 初始化压缩流
     */
    private void setupCompression() throws IOException {
        if (compressionType != CompressionType.NONE) {
            // 包装输出流，写入时自动压缩
            compressionStream = compressionType.wrapForOutput(bufferStream);
        } else {
            compressionStream = bufferStream;
        }
    }

    /**
     * 追加记录
     */
    public void append(Record record) throws IOException {
        // 写入到压缩流
        record.writeTo(compressionStream);
        numRecords++;
    }

    /**
     * 构建压缩后的 RecordBatch
     */
    public MemoryRecords build() throws IOException {
        if (compressionStream != null) {
            compressionStream.close();
        }

        ByteBuffer buffer = bufferStream.buffer();
        buffer.flip();

        // 更新批次头中的字段
        buffer.putInt(LENGTH_OFFSET, buffer.limit() - LOG_OVERHEAD);
        buffer.putInt(CRC_OFFSET, computeChecksum(buffer));

        return new MemoryRecords(buffer);
    }
}
```

### 6.4 压缩与幂等性

```java
/**
 * 压缩与幂等性的结合
 */
public class CompressedRecordBatch {

    /**
     * 压缩批次中的序列号：
     *
     * 批次头：
     *   baseSequence: 100
     *
     * 记录 0: offsetDelta=0, sequence=100
     * 记录 1: offsetDelta=1, sequence=101
     * 记录 2: offsetDelta=2, sequence=102
     *
     * 压缩后：
     * - 整个批次作为一个单元处理
     * - Broker 检查 baseSequence 的连续性
     * - 批次内部分记录重复会导致整个批次被拒绝
     */

    /**
     * Broker 端处理压缩批次：
     */
    public void appendCompressedBatch(RecordBatch batch) {
        if (batch.isCompressed()) {
            // 1. 校验批次级 CRC
            verifyBatchCrc(batch);

            // 2. 检查 PID + baseSequence
            if (batch.hasProducerId()) {
                verifySequence(batch.producerId(), batch.baseSequence());
            }

            // 3. 存储压缩数据（不解压）
            storeCompressed(batch);
        }
    }
}
```

**压缩算法对比**：

| 算法 | CPU 占用 | 压缩比 | 速度 | 推荐场景 |
|-----|---------|-------|------|---------|
| NONE | 无 | 1x | 最快 | 内网、CPU 受限 |
| Snappy | 低 | 2.0x | 很快 | 默认推荐 |
| LZ4 | 很低 | 2.1x | 最快 | 高吞吐 |
| GZIP | 高 | 2.5x | 慢 | 带宽受限 |
| ZSTD | 中 | 2.8x | 快 | Kafka 2.1+ |

---

**上一章**: [02. 请求响应格式详解](./02-request-response-format.md)
**下一章**: [04. 协议版本协商机制](./04-version-negotiation.md)
