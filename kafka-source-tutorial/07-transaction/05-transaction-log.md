# 05. 事务日志

## 本章导读

__transaction_state 是 Kafka 存储事务元数据的内部 Topic。本章将深入分析事务日志的结构、格式、压缩、加载机制以及状态恢复流程。

---

## 1. __transaction_state 概述

### 1.1 Topic 配置

```scala
/**
 * __transaction_state Topic 配置
 */

object TransactionLog {
    /**
     * Topic 名称
     */
    val TOPIC_NAME = "__transaction_state"

    /**
     * 默认分区数
     * - 基于 Transactional ID 分区
     */
    val DEFAULT_NUM_PARTITIONS = 50

    /**
     * 副本因子
     * - 默认为 3，保证高可用
     */
    val DEFAULT_REPLICATION_FACTOR = 3.toShort

    /**
     * 分段大小
     * - 较小的分段，便于快速恢复
     */
    val SEGMENT_SIZE_BYTES = 100 * 1024 * 1024  // 100MB

    /**
     * 保留时间
     * - 事务日志保留时间较长
     */
    val RETENTION_MS = 7 * 24 * 60 * 60 * 1000L  // 7天

    /**
     * 清理策略
     * - DELETE: 删除旧数据
     */
    val CLEANUP_POLICY = "DELETE"
}
```

### 1.2 消息类型

```scala
/**
 * __transaction_state 存储的消息类型:
 *
 * 1. 事务元数据 (TRANSACTION_TYPE)
 *    - Transactional ID → Producer ID/Epoch
 *    - 事务状态
 *    - 参与的分区列表
 *
 * 2. Producer ID 块 (PRODUCER_ID_TYPE)
 *    - Producer ID 分配记录
 *    - 用于 PID 块管理
 */

object TransactionLogKeyType extends Enumeration {
    /**
     * 事务元数据
     */
    val TRANSACTION_TYPE = 0

    /**
     * Producer ID 块
     */
    val PRODUCER_ID_TYPE = 1
}
```

---

## 2. 日志格式

### 2.1 Key 格式

```scala
/**
 * TransactionLogKey 结构
 */

case class TransactionLogKey(
    /**
     * 消息类型
     * - 0: TRANSACTION_TYPE
     * - 1: PRODUCER_ID_TYPE
     */
    transactionType: Int,

    /**
     * 事务 ID 或 PID 块 ID
     */
    id: String,

    /**
     * 版本
     */
    version: Int
) {

    /**
     * 序列化为字节数组
     */
    def toBytes: Array[Byte] = {
        val byteStream = new ByteArrayOutputStream()
        val dataOut = new DataOutputStream(byteStream)

        try {
            /**
             * 1. 写入类型
             */
            dataOut.writeShort(transactionType)

            /**
             * 2. 写入 ID
             */
            val idBytes = id.getBytes(StandardCharsets.UTF_8)
            dataOut.writeShort(idBytes.length)
            dataOut.write(idBytes)

            /**
             * 3. 写入版本
             */
            dataOut.writeShort(version)

            byteStream.toByteArray

        } finally {
            dataOut.close()
        }
    }
}

/**
 * 反序列化
 */
object TransactionLogKey {
    def fromBytes(bytes: Array[Byte]): TransactionLogKey = {
        val dataIn = new DataInputStream(new ByteArrayInputStream(bytes))

        try {
            val transactionType = dataIn.readShort()
            val idLength = dataIn.readShort()
            val idBytes = new Array[Byte](idLength)
            dataIn.readFully(idBytes)
            val id = new String(idBytes, StandardCharsets.UTF_8)
            val version = dataIn.readShort()

            TransactionLogKey(transactionType, id, version)

        } finally {
            dataIn.close()
        }
    }
}
```

### 2.2 Value 格式

```scala
/**
 * TransactionLogValue 结构
 */

case class TransactionLogValue(
    /**
     * Producer ID
     */
    producerId: Long,

    /**
     * Producer Epoch
     */
    producerEpoch: Short,

    /**
     * 事务超时时间
     */
    timeout: Int,

    /**
     * 事务状态
     */
    state: TransactionState,

    /**
     * 参与的分区列表
     */
    topicPartitions: Set[TopicPartition],

    /**
     * 最后更新时间戳
     */
    lastUpdateTimestamp: Long
) {

    /**
     * 序列化为字节数组
     */
    def toBytes: Array[Byte] = {
        val byteStream = new ByteArrayOutputStream()
        val dataOut = new DataOutputStream(byteStream)

        try {
            /**
             * 1. 写入 Producer ID
             */
            dataOut.writeLong(producerId)

            /**
             * 2. 写入 Producer Epoch
             */
            dataOut.writeShort(producerEpoch)

            /**
             * 3. 写入超时时间
             */
            dataOut.writeInt(timeout)

            /**
             * 4. 写入状态
             */
            dataOut.writeByte(state.id)

            /**
             * 5. 写入分区列表
             */
            dataOut.writeInt(topicPartitions.size)
            for (tp <- topicPartitions) {
                val topicBytes = tp.topic().getBytes(StandardCharsets.UTF_8)
                dataOut.writeShort(topicBytes.length)
                dataOut.write(topicBytes)
                dataOut.writeInt(tp.partition())
            }

            /**
             * 6. 写入时间戳
             */
            dataOut.writeLong(lastUpdateTimestamp)

            byteStream.toByteArray

        } finally {
            dataOut.close()
        }
    }
}

/**
 * 反序列化
 */
object TransactionLogValue {
    def fromBytes(bytes: Array[Byte]): TransactionLogValue = {
        val dataIn = new DataInputStream(new ByteArrayInputStream(bytes))

        try {
            val producerId = dataIn.readLong()
            val producerEpoch = dataIn.readShort()
            val timeout = dataIn.readInt()
            val stateId = dataIn.readByte()
            val state = TransactionState.fromId(stateId)

            val numPartitions = dataIn.readInt()
            val partitions = new mutable.HashSet[TopicPartition]()

            for (_ <- 0 until numPartitions) {
                val topicLength = dataIn.readShort()
                val topicBytes = new Array[Byte](topicLength)
                dataIn.readFully(topicBytes)
                val topic = new String(topicBytes, StandardCharsets.UTF_8)
                val partition = dataIn.readInt()

                partitions += new TopicPartition(topic, partition)
            }

            val timestamp = dataIn.readLong()

            TransactionLogValue(
                producerId,
                producerEpoch,
                timeout,
                state,
                partitions.toSet,
                timestamp
            )

        } finally {
            dataIn.close()
        }
    }
}
```

---

## 3. 日志写入

### 3.1 写入流程

```scala
/**
 * 写入事务日志
 */

def appendTransactionToLog(
    transactionalId: String,
    coordinatorEpoch: Int,
    metadata: TransactionMetadata,
    responseCallback: Errors => Unit
): Unit = {

    log.debug(s"写入事务日志: $transactionalId")

    /**
     * 1. 构建 Key 和 Value
     */
    val key = new TransactionLogKey(
        TransactionLogKey.TransactionType.TRANSACTION_TYPE,
        transactionalId,
        version = 0
    )

    val value = new TransactionLogValue(
        producerId = metadata.producerId,
        producerEpoch = metadata.producerEpoch,
        timeout = metadata.txnTimeoutMs,
        state = metadata.state,
        topicPartitions = metadata.topicPartitions,
        timestamp = time.milliseconds()
    )

    /**
     * 2. 构建 MemoryRecords
     */
    val records = MemoryRecords.withRecords(
        TransactionLog.ENCODING,
        CompressionType.NONE,
        new SimpleRecord(key.toBytes, value.toBytes)
    )

    /**
     * 3. 计算 Topic 分区
     */
    val partitionId = partitionFor(transactionalId)
    val topicPartition = new TopicPartition(
        TransactionLog.TOPIC_NAME,
        partitionId
    )

    /**
     * 4. 写入日志
     */
    val appendResult = replicaManager.appendRecords(
        timeout = txnConfig.transactionalIdExpirationMs,
        requiredAcks = -1,  // 等待所有副本
        internalTopicsAllowed = true,
        isFromClient = false,
        entriesPerPartition = Map(topicPartition -> records),
        responseCallback = responseCallback
    )

    /**
     * 5. 更新缓存
     */
    appendResult.onSuccess { _ =>
        transactionMetadataCache.put(
            transactionalId,
            coordinatorEpoch,
            metadata
        )
    }
}

/**
 * 计算 Transactional ID 对应的分区
 */
private def partitionFor(transactionalId: String): Int = {
    val hash = Math.abs(transactionalId.hashCode)
    hash % txnConfig.transactionLogNumPartitions
}
```

---

## 4. 日志加载

### 4.1 加载流程

```scala
/**
 * 加载事务日志
 */

def loadTransactionState(topicPartition: TopicPartition): Unit = {
    val partitionId = topicPartition.partition()

    log.info(s"加载事务状态: $topicPartition")

    /**
     * 1. 获取日志
     */
    val log = replicaManager.getLog(topicPartition)

    log match {
        case Some(log) =>
            /**
             * 2. 创建加载器
             */
            val loader = new TransactionLogLoader(
                partitionId,
                txnConfig,
                transactionMetadataCache,
                time
            )

            /**
             * 3. 遍历日志记录
             */
            var recordsLoaded = 0
            for (batch <- log.log.batches.asScala) {
                for (record <- batch.records.asScala) {
                    /**
                     * 4. 解析记录
                     */
                    try {
                        val key = TransactionLogKey.fromBytes(record.key)
                        val value = if (record.value != null) {
                            Some(TransactionLogValue.fromBytes(record.value))
                        } else {
                            None
                        }

                        /**
                         * 5. 处理记录
                         */
                        key.transactionType match {
                            case TransactionLogKey.TransactionType.TRANSACTION_TYPE =>
                                loader.loadTransaction(key, value)

                            case TransactionLogKey.TransactionType.PRODUCER_ID_TYPE =>
                                loader.loadProducerIdBlock(key, value)
                        }

                        recordsLoaded += 1

                    } catch {
                        case ex: Exception =>
                            log.error(s"加载事务记录失败: ${ex.getMessage}", ex)
                    }
                }
            }

            log.info(s"加载完成，共加载 $recordsLoaded 条事务记录")

            /**
             * 6. 补偿未完成的事务
             */
            loader.recoverIncompleteTransactions()

        case None =>
            log.warn(s"事务日志分区不存在: $topicPartition")
    }
}
```

### 4.2 日志加载器

```scala
/**
 * TransactionLogLoader
 */

class TransactionLogLoader(
    partitionId: Int,
    txnConfig: TransactionConfig,
    metadataCache: TxnMetadataCache,
    time: Time
) extends Logging {

    /**
     * 最新的事务元数据
     * - Key: Transactional ID
     * - Value: TransactionMetadata
     */
    private val latestMetadata = new ConcurrentHashMap[String, TransactionMetadata]()

    /**
     * 加载事务记录
     */
    def loadTransaction(
        key: TransactionLogKey,
        value: Option[TransactionLogValue]
    ): Unit = {
        val transactionalId = key.id

        value match {
            case None =>
                /**
                 * Value 为 null，表示删除
                 */
                log.debug(s"删除事务: $transactionalId")
                latestMetadata.remove(transactionalId)

            case Some(logValue) =>
                /**
                 * 构建事务元数据
                 */
                val metadata = TransactionMetadata(
                    producerId = logValue.producerId,
                    producerEpoch = logValue.producerEpoch,
                    txnTimeoutMs = logValue.timeout,
                    state = logValue.state,
                    topicPartitions = logValue.topicPartitions,
                    lastUpdateTimestamp = logValue.timestamp
                )

                /**
                 * 更新最新元数据
                 */
                latestMetadata.put(transactionalId, metadata)

                log.debug(s"加载事务: $transactionalId, state=${metadata.state}")
        }
    }

    /**
     * 加载 Producer ID 块
     */
    def loadProducerIdBlock(
        key: TransactionLogKey,
        value: Option[TransactionLogValue]
    ): Unit = {
        value match {
            case Some(logValue) =>
                /**
                 * 更新当前 Producer ID
                 */
                producerIdManager.updateCurrentProducerId(logValue.producerId)

            case None =>
                // 忽略
        }
    }

    /**
     * 补偿未完成的事务
     */
    def recoverIncompleteTransactions(): Unit = {
        log.info("补偿未完成的事务")

        /**
         * 1. 遍历所有事务
         */
        val incompleteTxns = new mutable.ArrayBuffer[String]()

        for (entry <- latestMetadata.entrySet.asScala) {
            val transactionalId = entry.getKey
            val metadata = entry.getValue

            /**
             * 2. 检查状态
             */
            if (metadata.state == TransactionState.PrepareCommit ||
                metadata.state == TransactionState.PrepareAbort) {

                log.warn(s"发现未完成的事务: $transactionalId, state=${metadata.state}")

                incompleteTxns += transactionalId
            }
        }

        /**
         * 3. 补偿未完成的事务
         */
        for (transactionalId <- incompleteTxns) {
            val metadata = latestMetadata.get(transactionalId)

            val command = metadata.state match {
                case TransactionState.PrepareCommit => TransactionResult.COMMIT
                case TransactionState.PrepareAbort => TransactionResult.ABORT
                case _ => throw new IllegalStateException()
            }

            log.info(s"补偿事务: $transactionalId, command=${command.name}")

            /**
             * 发送 Transaction Marker
             */
            val markerRequest = TransactionMarkerRequest(
                transactionalId = transactionalId,
                producerId = metadata.producerId,
                producerEpoch = metadata.producerEpoch,
                command = command,
                partitions = metadata.topicPartitions.toSet,
                coordinatorEpoch = 0
            )

            txnMarkerChannelManager.addRequest(markerRequest)
        }
    }

    /**
     * 构建缓存
     */
    def buildCache(): Unit = {
        /**
         * 将最新元数据放入缓存
         */
        for (entry <- latestMetadata.entrySet.asScala) {
            metadataCache.put(
                entry.getKey,
                coordinatorEpoch = 0,
                entry.getValue
            )
        }
    }
}
```

---

## 5. 日志压缩

### 5.1 压缩策略

```scala
/**
 * __transaction_state 压缩策略:
 *
 * 1. 启用压缩
 *    - cleanup.policy=compact,delete
 *    - 保留每个 Key 的最新值
 *
 * 2. 压缩时机
 *    - 当脏数据率达到阈值
     * - 默认 50%
     *
 * 3. 保留策略
 *    - 删除旧数据
 *    - 保留时间 7 天
 */

/**
 * 创建 __transaction_state Topic
 */
def createTransactionLogTopic(): Unit = {
    val topic = new org.apache.kafka.common.TopicPartition(
        TransactionLog.TOPIC_NAME,
        0
    )

    val config = new java.util.HashMap[String, String]()
    config.put("segment.bytes", "104857600")  // 100MB
    config.put("compression.type", "producer")
    config.put("cleanup.policy", "compact,delete")
    config.put("delete.retention.ms", "604800000")  // 7天
    config.put("min.cleanable.dirty.ratio", "0.5")
    config.put("min.compaction.lag.ms", "0")

    adminClient.createTopics(
        new NewTopic(
            TransactionLog.TOPIC_NAME,
            TransactionLog.DEFAULT_NUM_PARTITIONS,
            TransactionLog.DEFAULT_REPLICATION_FACTOR
        ).configs(config)
    )
}
```

### 5.2 压缩效果

```scala
/**
 * 压缩前后对比
 *
 * 压缩前:
 * - tx1: state=Empty, epoch=0
 * - tx1: state=Ongoing, epoch=0
 * - tx1: state=PrepareCommit, epoch=0
 * - tx1: state=CompleteCommit, epoch=0
 * - tx1: state=Empty, epoch=0
 *
 * 压缩后:
 * - tx1: state=Empty, epoch=0
 *
 * 减少 80% 存储空间
 */
```

---

## 6. 监控指标

### 6.1 JMX 指标

```scala
/**
 * __transaction_state 监控指标
 */

object TransactionLogMetrics {
    /**
     * 日志大小
     */
    val LOG_SIZE = "transaction-log-size"

    /**
     * 消息数量
     */
    val NUM_MESSAGES = "transaction-log-num-messages"

    /**
     * 压缩比率
     */
    val COMPRESSION_RATIO = "transaction-log-compression-ratio"

    /**
     * 加载时间
     */
    val LOAD_TIME_MS = "transaction-log-load-time-ms"
}
```

---

## 7. 总结

### 7.1 核心要点

1. **Topic 特性**
   - 内部 Topic，不对外暴露
   - 多副本，保证高可用
   - 压缩策略，减少存储

2. **消息格式**
   - Key: Transactional ID
   - Value: 事务元数据
   - 版本化，支持升级

3. **加载机制**
   - 启动时加载
   - 恢复状态
   - 补偿未完成事务

4. **压缩策略**
   - 保留最新值
   - 减少存储空间
   - 提高加载速度

### 7.2 下一步学习

- **[06-idempotence.md](./06-idempotence.md)** - 学习幂等性保证机制
- **[07-transaction-operations.md](./07-transaction-operations.md)** - 了解事务操作

---

**思考题**：
1. __transaction_state 需要多大空间？如何估算？
2. 如果 __transaction_state 数据丢失，会发生什么？
3. 为什么需要日志压缩？不压缩有什么问题？
