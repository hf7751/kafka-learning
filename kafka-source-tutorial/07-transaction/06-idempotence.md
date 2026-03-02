# 06. 幂等性保证

## 本章导读

幂等性是 Kafka 事务机制的基础，保证每条消息只被处理一次。本章将深入分析 Kafka 如何通过 Producer ID、Producer Epoch 和 Sequence Number 实现幂等性。

---

## 1. 幂等性概述

### 1.1 什么是幂等性

```scala
/**
 * 幂等性定义：
 *
 * 数学定义：f(x) = f(f(x))
 * - 相同的输入，执行多次，结果相同
 *
 * 在消息系统中的意义：
 * - 消息不会重复
 * - 消息不会丢失
 * - Exactly-Once 语义的基础
 */

/**
 * 幂等性的三个层次：
 *
 * 1. At-Most-Once（最多一次）
 *    - 消息可能丢失
 *    - 但不会重复
 *    - 适用于可容忍丢失的场景
 *
 * 2. At-Least-Once（至少一次）
 *    - 消息不会丢失
 *    - 但可能重复
 *    - 需要消费者去重
 *
 * 3. Exactly-Once（精确一次）
 *    - 消息不丢失
 *    - 消息不重复
 *    - 理想的语义
 */
```

### 1.2 为什么需要幂等性

```scala
/**
 * 幂等性解决的核心问题:
 *
 * 1. 网络重试导致的消息重复
 *    - 生产者发送消息后，网络超时
 *    - 生产者重试，发送了相同的消息
 *    - Broker 需要识别并丢弃重复消息
 *
 * 2. Broker 故障导致的消息重复
 *    - Broker 写入消息后宕机
 *    - 生产者未收到 ACK，重试
 *    - Broker 重启后，收到重复消息
 *
 * 3. 多副本复制导致的消息重复
 *    - Leader 写入成功，Follower 未同步
 *    - Leader 故障，Follower 成为新 Leader
 *    - 生产者重试，新 Leader 收到重复消息
 */

// 示例: 没有幂等性的情况
// 1. 生产者发送消息: "order=123, amount=100"
// 2. Broker 写入成功，但 ACK 丢失
// 3. 生产者超时，重试: "order=123, amount=100"
// 4. Broker 写入重复消息
// 5. 消费者消费两次，扣款 200 元！

// 使用幂等性:
// 1. 生产者发送消息: PID=1, Epoch=0, Seq=0, "order=123, amount=100"
// 2. Broker 写入成功，记录: PID=1, Epoch=0, Seq=0
// 3. Broker ACK 丢失
// 4. 生产者重试: PID=1, Epoch=0, Seq=0, "order=123, amount=100"
// 5. Broker 检测到重复，丢弃
```

---

## 2. 幂等性实现原理

### 2.1 核心机制

```scala
/**
 * Kafka 幂等性的核心机制:
 *
 * 1. Producer ID (PID)
 *    - 每个 Producer 分配唯一 ID
 *    - 系统分配，长整型，单调递增
 *    - 初始化时分配，重启后可能变化
 *
 * 2. Producer Epoch
 *    - Producer 的版本号
 *    - 短整型，每次 PID 冲突时递增
 *    - 隔离旧的 Producer
 *
 * 3. Sequence Number
 *    - 每个 Partition 独立的序列号
 *    - 从 0 开始，严格递增
 *    - 服务端检测重复
 */

/**
 * 幂等性标识符
 */
case class ProducerIdAndEpoch(
    producerId: Long,
    producerEpoch: Short
)

/**
 * 序列号标识符
 */
case class SequenceIdentifier(
    producerId: Long,
    producerEpoch: Short,
    sequence: Int
)
```

### 2.2 客户端实现

```scala
/**
 * 客户端序列号管理
 */

// org/apache/kafka/clients/producer/internals/Sender.java

class ProducerIdManager {
    /**
     * Producer ID
     */
    private var producerId: Long = ProducerId.NO_PRODUCER_ID

    /**
     * Producer Epoch
     */
    private var producerEpoch: Short = ProducerId.NO_PRODUCER_EPOCH

    /**
     * 序列号映射
     * - Key: TopicPartition
     * - Value: 下一个序列号
     */
    private val sequenceNumbers = new ConcurrentHashMap[TopicPartition, Integer]()

    /**
     * 初始化 Producer ID
     */
    def initProducerId(): Unit = {
        /**
         * 1. 向 Broker 请求 PID
         */
        val response = sendInitProducerIdRequest()

        /**
         * 2. 保存 PID 和 Epoch
         */
        producerId = response.producerId
        producerEpoch = response.producerEpoch

        log.info(s"初始化 Producer ID: $producerId, Epoch: $producerEpoch")
    }

    /**
     * 获取下一个序列号
     */
    def nextSequence(topicPartition: TopicPartition): Int = {
        /**
         * 1. 获取当前序列号
         */
        val current = sequenceNumbers.get(topicPartition)

        /**
         * 2. 计算下一个序列号
         */
        val next = if (current == null) {
            0
        } else {
            current + 1
        }

        /**
         * 3. 更新序列号
         */
        sequenceNumbers.put(topicPartition, next)

        next
    }

    /**
     * 发送成功后更新序列号
     */
    def updateSequence(topicPartition: TopicPartition, sequence: Int): Unit = {
        sequenceNumbers.put(topicPartition, sequence + 1)
    }

    /**
     * 发送失败，重置序列号
     * - 重试时使用相同的序列号
     */
    def resetSequence(topicPartition: TopicPartition): Unit = {
        val current = sequenceNumbers.get(topicPartition)
        if (current != null && current > 0) {
            sequenceNumbers.put(topicPartition, current - 1)
        }
    }
}
```

### 2.3 服务端实现

```scala
/**
 * 服务端序列号检测
 */

// kafka/server/ReplicaManager.scala

class ReplicaManager {
    /**
     * Producer 序列号管理器
     */
    private val producerSeqStateManager = new ProducerStateManager()

    /**
     * 追加消息到日志
     */
    def appendRecords(
        timeout: Long,
        requiredAcks: Short,
        internalTopicsAllowed: Boolean,
        isFromClient: Boolean,
        entriesPerPartition: Map[TopicPartition, MemoryRecords],
        responseCallback: Map[TopicPartition, PartitionResponse] => Unit
    ): Unit = {

        val results = new ConcurrentHashMap[TopicPartition, PartitionResponse]()

        /**
         * 1. 遍历每个分区
         */
        for (partitionData <- entriesPerPartition) {
            val tp = partitionData._1
            val records = partitionData._2

            try {
                /**
                 * 2. 获取分区
                 */
                val partition = getPartition(tp)

                /**
                 * 3. 验证序列号
                 */
                val (validRecords, sequenceError) = validateSequenceNumbers(tp, records)

                sequenceError match {
                    case None =>
                        /**
                         * 序列号有效，追加消息
                         */
                        val appendInfo = partition.appendRecordsToLeader(
                            validRecords,
                            requiredAcks,
                            internalTopicsAllowed
                        )

                        results.put(tp, new PartitionResponse(
                            Errors.NONE,
                            appendInfo.firstOffset,
                            appendInfo.recordErrors.asScala,
                            appendInfo.errorMessage
                        ))

                    case Some(error) =>
                        /**
                         * 序列号无效，返回错误
                         */
                        results.put(tp, new PartitionResponse(
                            error,
                            -1,
                            RecordBatch.NO_TIMESTAMP,
                            -1
                        ))

                        log.error(s"序列号验证失败: $tp, error: $error")
                }

            } catch {
                case ex: Exception =>
                    results.put(tp, new PartitionResponse(
                        Errors.UNKNOWN_SERVER_ERROR,
                        -1,
                        RecordBatch.NO_TIMESTAMP,
                        -1
                    ))
            }
        }

        /**
         * 4. 返回结果
         */
        responseCallback(results.asScala.toMap)
    }

    /**
     * 验证序列号
     */
    private def validateSequenceNumbers(
        tp: TopicPartition,
        records: MemoryRecords
    ): (MemoryRecords, Option[Errors]) = {

        val validRecords = new ArrayBuffer[MutableRecordBatch]()

        /**
         * 遍历每个 Batch
         */
        for (batch <- records.batches.asScala) {
            /**
             * 获取 Producer ID 和 Epoch
             */
            val producerId = batch.producerId
            val producerEpoch = batch.producerEpoch

            /**
             * 检查是否是控制记录
             */
            if (batch.isControlBatch) {
                /**
                 * Transaction Marker，跳过验证
                 */
                validRecords += batch
            } else {
                /**
                 * 普通消息，验证序列号
                 */
                val error = producerSeqStateManager.checkSequence(
                    tp,
                    producerId,
                    producerEpoch,
                    batch.baseSequence,
                    batch.recordCount
                )

                error match {
                    case None =>
                        /**
                         * 序列号有效
                         */
                        validRecords += batch

                    case Some(err) =>
                        /**
                         * 序列号无效
                         */
                        log.error(s"序列号无效: tp=$tp, pid=$producerId, epoch=$producerEpoch, " +
                                s"seq=${batch.baseSequence}, error=$err")
                        return (MemoryRecords.EMPTY, Some(err))
                }
            }
        }

        (MemoryRecords.withValidBatches(validRecords.asJava), None)
    }
}
```

### 2.4 序列号验证逻辑

```scala
/**
 * Producer 序列号管理器
 */

// kafka/log/ProducerStateManager.scala

class ProducerStateManager {
    /**
     * Producer 状态映射
     * - Key: Producer ID
     * - Value: Producer State
     */
    private val producers = new ConcurrentHashMap[Long, ProducerState]()

    /**
     * 检查序列号
     */
    def checkSequence(
        tp: TopicPartition,
        producerId: Long,
        producerEpoch: Short,
        baseSequence: Int,
        recordCount: Int
    ): Option[Errors] = {

        /**
         * 1. 获取 Producer 状态
         */
        val state = producers.get(producerId)

        if (state == null) {
            /**
             * 首次写入，序列号必须从 0 开始
             */
            if (baseSequence != 0) {
                return Some(Errors.OUT_OF_ORDER_SEQUENCE_NUMBER)
            }

            /**
             * 创建新的 Producer 状态
             */
            val newState = new ProducerState(
                producerId = producerId,
                producerEpoch = producerEpoch,
                lastSequence = baseSequence + recordCount - 1,
                lastTimestamp = time.milliseconds()
            )

            producers.put(producerId, newState)

            return None
        }

        /**
         * 2. 验证 Producer Epoch
         */
        if (state.producerEpoch != producerEpoch) {
            /**
             * Epoch 不匹配
             * - 新 Epoch: 序列号从 0 开始
             * - 旧 Epoch: 拒绝
             */
            if (producerEpoch > state.producerEpoch) {
                /**
                 * 新 Epoch，验证序列号是否从 0 开始
                 */
                if (baseSequence != 0) {
                    return Some(Errors.OUT_OF_ORDER_SEQUENCE_NUMBER)
                }

                /**
                 * 更新 Epoch
                 */
                state.updateEpoch(producerEpoch)
                state.lastSequence = baseSequence + recordCount - 1

                return None
            } else {
                /**
                 * 旧 Epoch，拒绝
                 */
                return Some(Errors.PRODUCER_FENCED)
            }
        }

        /**
         * 3. 验证序列号
         */
        val expectedSequence = state.lastSequence + 1

        if (baseSequence != expectedSequence) {
            /**
             * 序列号不连续
             */
            return Some(Errors.OUT_OF_ORDER_SEQUENCE_NUMBER)
        }

        /**
         * 4. 更新最后序列号
         */
        state.lastSequence = baseSequence + recordCount - 1

        None
    }
}

/**
 * Producer 状态
 */
class ProducerState(
    var producerId: Long,
    var producerEpoch: Short,
    var lastSequence: Int,
    var lastTimestamp: Long
) {
    /**
     * 更新 Epoch
     */
    def updateEpoch(newEpoch: Short): Unit = {
        producerEpoch = newEpoch
        lastSequence = -1  // 重置序列号
    }

    /**
     * 更新序列号
     */
    def updateSequence(sequence: Int): Unit = {
        lastSequence = sequence
        lastTimestamp = time.milliseconds()
    }
}
```

---

## 3. Producer Epoch 隔离

### 3.1 僵尸生产者问题

```scala
/**
 * 僵尸生产者问题:
 *
 * 场景:
 * 1. 生产者 P1 使用 PID=1, Epoch=0 发送消息
 * 2. P1 网络故障，长时间无响应
 * 3. 新生产者 P2 启动，使用相同的 transactional.id
 * 4. P2 被分配 PID=1, Epoch=1
 * 5. P1 网络恢复，继续使用 Epoch=0 发送消息
 *
 * 问题: 如何区分 P1 和 P2？
 *
 * 解决方案: Producer Epoch
 * - 每次递增 Epoch
 * - 只接受最新 Epoch 的消息
 * - 旧 Epoch 的消息被拒绝
 */
```

### 3.2 Epoch 递增流程

```scala
/**
 * Epoch 递增流程
 */

def handleInitProducerId(
    transactionalId: String,
    expectedProducerIdAndEpoch: Option[ProducerIdAndEpoch],
    responseCallback: InitProducerIdCallback
): Unit = {

    transactionManager.getTransactionState(transactionalId) match {
        case None =>
            /**
             * 首次使用，分配新的 PID 和 Epoch=0
             */
            val producerId = producerIdManager.allocateProducerId()
            responseCallback(InitProducerIdResult(producerId, 0))

        case Some(CoordinatorEpochAndTxnMetadata(_, txnMetadata)) =>
            txnMetadata.inLock(() => {
                val currentPid = txnMetadata.producerId
                val currentEpoch = txnMetadata.producerEpoch

                expectedProducerIdAndEpoch match {
                    case Some(expected) =>
                        /**
                         * 生产者提供了期望的 PID/Epoch
                         */
                        if (expected.producerId == currentPid &&
                            expected.producerEpoch == currentEpoch) {
                            /**
                             * 匹配，继续使用
                             */
                            responseCallback(InitProducerIdResult(currentPid, currentEpoch))
                        } else {
                            /**
                             * 不匹配，递增 Epoch
                             */
                            val newEpoch = (currentEpoch + 1).toShort
                            txnMetadata.producerEpoch = newEpoch
                            responseCallback(InitProducerIdResult(currentPid, newEpoch))
                        }

                    case None =>
                        /**
                         * 未提供期望的 PID/Epoch
                         * 递增 Epoch，隔离旧生产者
                         */
                        val newEpoch = (currentEpoch + 1).toShort
                        txnMetadata.producerEpoch = newEpoch
                        responseCallback(InitProducerIdResult(currentPid, newEpoch))
                }
            })
    }
}
```

### 3.3 Epoch 验证

```scala
/**
 * 服务端 Epoch 验证
 */

def validateEpoch(
    expectedEpoch: Short,
    actualEpoch: Short
): Errors = {
    if (actualEpoch < expectedEpoch) {
        /**
         * 旧 Epoch，拒绝
         */
        Errors.PRODUCER_FENCED
    } else if (actualEpoch > expectedEpoch) {
        /**
         * 新 Epoch，更新
         */
        Errors.NONE
    } else {
        /**
         * 相同 Epoch，继续
         */
        Errors.NONE
    }
}
```

---

## 4. 幂等性与事务的关系

### 4.1 幂等性是事务的基础

```scala
/**
 * 幂等性与事务的关系:
 *
 * 1. 事务自动启用幂等性
 *    - 即使配置 enable.idempotence=false
 *    - 事务仍然使用 PID + Epoch + Sequence
 *
 * 2. 事务扩展了幂等性
 *    - 幂等性: 单分区内不重复
 *    - 事务: 跨分区原子性
 *
 * 3. 共同机制
 *    - 都使用 Producer ID
 *    - 都使用 Sequence Number
 *    - 都使用 Producer Epoch
 */
```

### 4.2 对比

| 特性 | 幂等性 | 事务 |
|------|--------|------|
| **配置参数** | `enable.idempotence=true` | `transactional.id=xxx` |
| **作用范围** | 单个 Partition | 多个 Partition |
| **保证语义** | Per-Partition 幂等 | 跨分区原子性 |
| **依赖组件** | Producer ID + Sequence | TransactionCoordinator |
| **使用场景** | 防止重复消息 | 端到端 Exactly-Once |

---

## 5. 配置与使用

### 5.1 启用幂等性

```java
/**
 * 配置幂等性
 */

Properties props = new Properties();

/**
 * 1. 启用幂等性
 */
props.put("enable.idempotence", "true");

/**
 * 2. 配置重试
 * - 幂等性要求 max.in.flight.requests.per.connection <= 5
 * - 使用顺序保证的重试
 */
props.put("max.in.flight.requests.per.connection", "5");
props.put("retries", "3");

/**
 * 3. 配置 ACK
 * - 幂等性要求 acks=all
 */
props.put("acks", "all");

KafkaProducer<String, String> producer = new KafkaProducer<>(props);
```

### 5.2 使用事务

```java
/**
 * 配置事务
 */

Properties props = new Properties();

/**
 * 1. 设置事务 ID
 * - 必须设置，且唯一
 */
props.put("transactional.id", "order-processor-1");

/**
 * 2. 配置 ACK
 * - 事务要求 acks=all
 */
props.put("acks", "all");

/**
 * 3. 启用幂等性（自动启用）
 */
// enable.idempotence 自动设置为 true

KafkaProducer<String, String> producer = new KafkaProducer<>(props);

/**
 * 初始化事务
 */
producer.initTransactions();

try {
    /**
     * 开启事务
     */
    producer.beginTransaction();

    /**
     * 发送消息
     */
    producer.send(new ProducerRecord<>("orders", "order-1"));
    producer.send(new ProducerRecord<>("orders", "order-2"));

    /**
     * 提交事务
     */
    producer.commitTransaction();

} catch (Exception e) {
    /**
     * 回滚事务
     */
    producer.abortTransaction();
}
```

---

## 6. 性能影响

### 6.1 性能开销

```scala
/**
 * 幂等性的性能开销:
 *
 * 1. 序列号管理
 *    - 客户端维护序列号映射
 *    - 服务端验证序列号
 *    - 开销较小
 *
 * 2. 去重检测
 *    - 服务端比较序列号
 *    - O(1) 时间复杂度
 *    - 开销较小
 *
 * 3. 状态存储
 *    - 服务端缓存 Producer 状态
 *    - 内存占用
 *    - 需要定期清理
 */
```

### 6.2 优化建议

| 优化项 | 说明 |
|--------|------|
| **批量大小** | 增大 batch.size，减少请求次数 |
| **并发度** | max.in.flight.requests.per.connection <= 5 |
| **重试次数** | 合理设置 retries，避免无限重试 |
| **序列号缓存** | 定期清理过期的 Producer 状态 |

---

## 7. 监控指标

### 7.1 JMX 指标

```scala
/**
 * 幂等性监控指标
 */

object IdempotenceMetrics {
    /**
     * 序列号错误次数
     */
    val OUT_OF_ORDER_SEQUENCE_ERROR = "out-of-order-sequence-error"

    /**
     * Producer 冲突次数
     */
    val PRODUCER_FENCED_ERROR = "producer-fenced-error"

    /**
     * 重复消息次数
     */
    val DUPLICATE_MESSAGE_COUNT = "duplicate-message-count"
}
```

---

## 8. 总结

### 8.1 核心要点

1. **幂等性机制**
   - Producer ID: 唯一标识生产者
   - Producer Epoch: 版本号，隔离旧生产者
   - Sequence Number: 序列号，检测重复

2. **实现原理**
   - 客户端维护序列号
   - 服务端验证序列号
   - 重复序列号被拒绝

3. **与事务的关系**
   - 幂等性是事务的基础
   - 事务自动启用幂等性
   - 共享相同的机制

### 8.2 下一步学习

- **[07-transaction-operations.md](./07-transaction-operations.md)** - 学习事务操作
- **[08-transaction-monitoring.md](./08-transaction-monitoring.md)** - 了解监控指标

---

**思考题**：
1. 为什么每个 Partition 需要独立的序列号？使用全局序列号有什么问题？
2. Producer Epoch 耗尽了怎么办？
3. 幂等性会影响性能吗？如何优化？
