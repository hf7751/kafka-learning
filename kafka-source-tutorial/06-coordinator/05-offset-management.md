# 05. Offset 管理

## 5.1 Offset 概述

### 什么是 Offset

```scala
/**
 * Offset 定义:
 *
 * Offset 是消息在分区中的逻辑序号，表示消费位置。
 * Kafka 使用 Offset 来跟踪消费者的消费进度。
 *
 * Offset 的作用:
 * 1. 记录消费进度
 *    - 标记已消费的消息位置
 *    - 支持断点续传
 *
 * 2. 实现消费语义
 *    - 至少一次: 提交成功后处理
 *    - 至多一次: 处理后提交
 *    - 精确一次: 事务支持
 *
 * 3. 故障恢复
 *    - 消费者故障后从上次位置继续
 *    - 支持重置到指定位置
 * /
```

### Offset 存储演进

```scala
/**
 * Offset 存储方式演进:
 *
 * Kafka 0.8 之前:
 * - 存储在 ZooKeeper
 * - 性能瓶颈
 * - 扩展性差
 *
 * Kafka 0.9 之后:
 * - 存储在 __consumer_offsets Topic
 * - 高性能
 * - 可扩展
 * - 支持批量操作
 * /
```

## 5.2 __consumer_offsets Topic

### Topic 结构

```scala
/**
 * __consumer_offsets Topic 结构:
 *
 * 1. 基本配置
 *    - 默认分区数: 50
 *    - 副本因子: 3
 *    - 压缩策略: LZ4/GZIP
 *
 * 2. 消息格式
 *    - Key: Group ID + Topic + Partition
 *    - Value: Offset + Metadata + Timestamp
 *
 * 3. 分区规则
 *    - partition = abs(groupId.hashCode) % 50
 *    - 保证同一组的数据在同一分区
 * /

// 消息 Key 格式
case class OffsetKey(
    version: Short,                         // 版本号
    group: String,                          // Group ID
    topic: String,                          // Topic 名称
    partition: Int                          // 分区号
)

// 消息 Value 格式
case class OffsetValue(
    version: Short,                         // 版本号
    offset: Long,                           // Offset 值
    leaderEpoch: Int,                       // Leader 代数
    metadata: String,                       // 元数据
    commitTimestamp: Long,                  // 提交时间戳
    expireTimestamp: Option[Long]           // 过期时间戳
)
```

### Key 的计算

```scala
/**
 * Offset Key 计算方法:
 *
 * 用于确定 Offset 记录存储到哪个分区
 * /
def offsetPartition(groupId: String): Int = {
    Math.abs(groupId.hashCode) % offsetsTopicPartitionCount
}

/**
 * 构建消息 Key
 * /
def buildOffsetKey(
    groupId: String,
    topicPartition: TopicPartition
): Array[Byte] = {
    val key = OffsetKey(
        version = 2,
        group = groupId,
        topic = topicPartition.topic,
        partition = topicPartition.partition
    )

    // 序列化
    serializeOffsetKey(key)
}

/**
 * 构建消息 Value
 * /
def buildOffsetValue(
    offsetAndMetadata: OffsetAndMetadata
): Array[Byte] = {
    val value = OffsetValue(
        version = 2,
        offset = offsetAndMetadata.offset,
        leaderEpoch = offsetAndMetadata.leaderEpoch.getOrElse(-1),
        metadata = offsetAndMetadata.metadata,
        commitTimestamp = time.milliseconds(),
        expireTimestamp = None
    )

    // 序列化
    serializeOffsetValue(value)
}
```

## 5.3 Offset 提交协议

### OffsetCommit 请求

```scala
/**
 * OffsetCommit 请求结构 (API Key: 8)
 *
 * Version 7 (Kafka 2.3+)
 * /
case class OffsetCommitRequest(
    // 组信息
    groupId: String,                         // Group ID
    generationId: Int,                       // 代数
    memberId: String,                        // 成员 ID
    groupInstanceId: Option[String],         // 静态成员 ID

    // 提交的 Offset
    topics: Map[String, Map[Int, OffsetCommitData]]  // Topic -> Partition -> Offset
) {
    /**
     * OffsetCommitData 结构:
     * - offset: Offset 值
     * - leaderEpoch: Leader 代数
     * - metadata: 元数据字符串
     * /
}

case class OffsetCommitData(
    offset: Long,
    leaderEpoch: Int,
    metadata: String
)
```

### OffsetCommit 响应

```scala
/**
 * OffsetCommit 响应结构
 * /
case class OffsetCommitResponse(
    // 响应码
    responses: Map[String, Map[Int, Short]]  // Topic -> Partition -> ErrorCode
)

/**
 * 常见错误码:
 * 1. NONE (0) - 提交成功
 * 2. GROUP_AUTHORIZATION_FAILED (30) - 权限不足
 * 3. OFFSET_METADATA_TOO_LARGE (29) - 元数据太大
 * 4. ILLEGAL_GENERATION (22) - 代数不匹配
 * 5. UNKNOWN_MEMBER_ID (25) - 成员不存在
 * 6. REBALANCE_IN_PROGRESS (27) - 正在 Rebalance
 * /
```

### OffsetCommit 处理流程

```scala
/**
 * OffsetCommit 处理流程
 * /
def handleOffsetCommit(
    groupId: String,
    generationId: Int,
    memberId: String,
    commits: Map[TopicPartition, OffsetAndMetadata]
): Map[TopicPartition, Errors] = {

    // 1. 获取组
    val group = getGroup(groupId)

    val results = mutable.Map[TopicPartition, Errors]()

    group.inLock {
        // 2. 验证组状态
        val (validationError, isUnknownMember) = validateOffsetCommit(
            group,
            generationId,
            memberId
        )

        if (validationError != Errors.NONE) {
            // 验证失败，所有分区返回相同错误
            commits.keys.foreach { tp =>
                results(tp) = validationError
            }
            return results.toMap
        }

        // 3. 处理每个分区的提交
        commits.foreach { case (tp, offsetAndMetadata) =>
            try {
                // 3.1 验证 Offset
                val error = validateOffset(tp, offsetAndMetadata)

                if (error != Errors.NONE) {
                    results(tp) = error
                } else {
                    // 3.2 写入 __consumer_offsets
                    appendOffsetToLog(
                        groupId = groupId,
                        topicPartition = tp,
                        offsetAndMetadata = offsetAndMetadata
                    )

                    // 3.3 更新缓存
                    offsetManager.cacheOffset(
                        groupId,
                        tp,
                        offsetAndMetadata
                    )

                    results(tp) = Errors.NONE
                }
            } catch {
                case e: Exception =>
                    error(s"Failed to commit offset for $tp", e)
                    results(tp) = Errors.UNKNOWN_SERVER_ERROR
            }
        }
    }

    results.toMap
}

/**
 * 验证 OffsetCommit 请求
 * /
private def validateOffsetCommit(
    group: GroupMetadata,
    generationId: Int,
    memberId: String
): (Errors, Boolean) = {
    // 1. 检查组是否存在
    if (group == null) {
        return (Errors.GROUP_AUTHORIZATION_FAILED, false)
    }

    // 2. 检查代数
    if (group.generationId != generationId) {
        // 静态成员允许更宽松的验证
        if (group.isStaticMember(memberId)) {
            return (Errors.NONE, true)
        }
        return (Errors.ILLEGAL_GENERATION, false)
    }

    // 3. 检查成员是否存在
    if (!group.has(memberId) && !group.isStaticMember(memberId)) {
        return (Errors.UNKNOWN_MEMBER_ID, false)
    }

    (Errors.NONE, false)
}

/**
 * 写入 __consumer_offsets
 * /
private def appendOffsetToLog(
    groupId: String,
    topicPartition: TopicPartition,
    offsetAndMetadata: OffsetAndMetadata
): Unit = {
    // 1. 构建消息
    val key = buildOffsetKey(groupId, topicPartition)
    val value = buildOffsetValue(offsetAndMetadata)

    // 2. 确定分区
    val partition = offsetPartition(groupId)

    // 3. 构建记录
    val records = MemoryRecords.withRecords(
        CompressionType.NONE,
        new SimpleRecord(
            time.milliseconds(),
            key,
            value
        )
    )

    // 4. 追加到日志
    val appendResult = replicaManager.appendRecords(
        timeout = offsetConfig.offsetsTopicSegmentBytes,
        requiredAcks = -1,  // 全部确认
        internalTopicsAllowed = true,
        isFromClient = false,
        entriesPerPartition = Map(
            TopicAndPartition(__consumerOffsetsTopic, partition) ->
                new LogAppendInfo(...)
        )
    )

    // 5. 等待写入完成
    appendResult.await(timeoutMs)
}
```

## 5.4 Offset 查询协议

### OffsetFetch 请求

```scala
/**
 * OffsetFetch 请求结构 (API Key: 9)
 *
 * Version 5 (Kafka 2.3+)
 * /
case class OffsetFetchRequest(
    groupId: String,                         // Group ID
    requireStable: Option[Boolean],          // 是否需要稳定状态
    topics: Option[Map[String, Seq[Int]]]   // Topic -> 分区列表
)

/**
 * 说明:
 * - topics 为 None 表示获取所有 Topic
 * - requireStable 表示要求组处于 Stable 状态
 * /
```

### OffsetFetch 响应

```scala
/**
 * OffsetFetch 响应结构
 * /
case class OffsetFetchResponse(
    errorCode: Short,                        // 组级别错误码
    responses: Map[String, Map[Int, OffsetFetchResponse]]  // Topic -> Partition -> Offset
    groupId: String,                         // Group ID
    // 集成模式下返回额外信息 (Kafka 2.4+)
    sessionType: Option[String],
    memberAssignment: Option[Array[Byte]]
)

/**
 * OffsetFetchResponse 结构
 * /
case class OffsetFetchResponse(
    offset: Long,                            // Offset 值
    leaderEpoch: Int,                        // Leader 代数
    metadata: String,                        // 元数据
    errorCode: Short                         // 错误码
)
```

### OffsetFetch 处理流程

```scala
/**
 * OffsetFetch 处理流程
 * /
def handleOffsetFetch(
    groupId: String,
    requireStable: Option[Boolean],
    topics: Option[Map[String, Seq[Int]]]
): OffsetFetchResponse = {

    // 1. 获取组
    val group = getGroup(groupId)

    // 2. 检查状态
    if (requireStable.getOrElse(false)) {
        if (group == null || !group.is(Stable)) {
            return OffsetFetchResponse(
                errorCode = Errors.UNSTABLE_GROUP_MEMBERSHIP.code,
                responses = Map.empty,
                groupId = groupId
            )
        }
    }

    // 3. 查询 Offset
    val offsets = mutable.Map[String, Map[Int, OffsetFetchResponse]]()

    topics match {
        case Some(requestedTopics) =>
            // 查询指定的 Topic
            requestedTopics.foreach { case (topic, partitions) =>
                val topicOffsets = mutable.Map[Int, OffsetFetchResponse]()

                partitions.foreach { partition =>
                    val tp = TopicPartition(topic, partition)
                    val cached = offsetManager.getCachedOffset(groupId, tp)

                    topicOffsets(partition) = cached match {
                        case Some(offsetAndMetadata) =>
                            OffsetFetchResponse(
                                offset = offsetAndMetadata.offset,
                                leaderEpoch = offsetAndMetadata.leaderEpoch.getOrElse(-1),
                                metadata = offsetAndMetadata.metadata,
                                errorCode = Errors.NONE.code
                            )

                        case None =>
                            // 未找到 Offset
                            OffsetFetchResponse(
                                offset = -1,
                                leaderEpoch = -1,
                                metadata = "",
                                errorCode = Errors.NONE.code  // 返回 -1 表示未提交
                            )
                    }
                }

                offsets(topic) = topicOffsets.toMap
            }

        case None =>
            // 查询所有 Topic
            val allOffsets = offsetManager.getAllOffsets(groupId)
            // 组织响应...
    }

    OffsetFetchResponse(
        errorCode = Errors.NONE.code,
        responses = offsets.toMap,
        groupId = groupId
    )
}
```

## 5.5 Offset 缓存管理

### 缓存结构

```scala
/**
 * Offset 缓存设计:
 *
 * 目的: 减少 __consumer_offsets 的读取，提升性能
 *
 * 结构: 两层缓存
 * 1. 内存缓存 - 热点数据
 * 2. 日志文件 - 持久化数据
 * /

class OffsetManager(
    config: OffsetManagerConfig,
    replicaManager: ReplicaManager,
    zkClient: KafkaZkClient,
    time: Time
) extends Logging {

    // 内存缓存
    private val offsetCache = new Pool[GroupTopicPartition, OffsetAndMetadata]()

    // 待删除的 Offset
    private val pendingDeleteOffsets = new HashSet[GroupTopicPartition]()

    // 加载锁
    private val loadLock = new ReentrantLock()

    /**
     * GroupTopicPartition 结构
     * /
    case class GroupTopicPartition(
        group: String,
        topicPartition: TopicPartition
    )
}
```

### 缓存加载

```scala
/**
 * 从 __consumer_offsets 加载 Offset
 * /
def loadOffsetsFromLog(): Unit = {
    loadLock.lock()
    try {
        // 1. 读取 __consumer_offsets 的所有分区
        val partitions = replicaManager.logManager.getLog(__consumerOffsetsTopic) match {
            case Some(log) =>
                log.logSegments.map(_.baseOffset).toList
            case None =>
                Seq.empty
        }

        // 2. 扫描日志消息
        partitions.foreach { partition =>
            val log = replicaManager.getLog(TopicAndPartition(__consumer_offsetsTopic, partition))

            log.foreach { log =>
                log.logSegments.foreach { segment =>
                    segment.log.foreach { record =>
                        try {
                            // 解析消息
                            val key = deserializeOffsetKey(record.key)
                            val value = deserializeOffsetValue(record.value)

                            // 构建缓存键
                            val gtp = GroupTopicPartition(
                                group = key.group,
                                topicPartition = new TopicPartition(key.topic, key.partition)
                            )

                            // 更新缓存
                            val offsetAndMetadata = OffsetAndMetadata(
                                offset = value.offset,
                                leaderEpoch = Some(value.leaderEpoch),
                                metadata = value.metadata,
                                commitTimestamp = value.commitTimestamp
                            )

                            offsetCache.put(gtp, offsetAndMetadata)
                        } catch {
                            case e: Exception =>
                                warn(s"Failed to load offset record", e)
                        }
                    }
                }
            }
        }

        info(s"Loaded ${offsetCache.size} offsets from __consumer_offsets")
    } finally {
        loadLock.unlock()
    }
}
```

### 缓存更新

```scala
/**
 * 更新 Offset 缓存
 * /
def cacheOffset(
    groupId: String,
    topicPartition: TopicPartition,
    offsetAndMetadata: OffsetAndMetadata
): Unit = {
    val gtp = GroupTopicPartition(groupId, topicPartition)

    // 更新缓存
    offsetCache.put(gtp, offsetAndMetadata)

    // 从待删除列表移除
    pendingDeleteOffsets.remove(gtp)
}

/**
 * 从缓存获取 Offset
 * /
def getCachedOffset(
    groupId: String,
    topicPartition: TopicPartition
): Option[OffsetAndMetadata] = {
    val gtp = GroupTopicPartition(groupId, topicPartition)
    Option(offsetCache.get(gtp))
}
```

## 5.6 Offset 过期与清理

### 过期策略

```scala
/**
 * Offset 过期策略:
 *
 * offsets.retention.minutes (默认 10080 = 7 天)
 * - Offset 的保留时间
 * - 超过此时间未使用的 Offset 会被清理
 *
 * 自动清理:
 * - 由后台任务定期执行
 * - 清理过期的 Offset
 * - 压缩 __consumer_offsets Topic
 * /

// 检查 Offset 是否过期
def isOffsetExpired(
    groupId: String,
    topicPartition: TopicPartition,
    offsetAndMetadata: OffsetAndMetadata
): Boolean = {
    val now = time.milliseconds()
    val retentionMs = config.offsetsRetentionMs

    // 检查最后提交时间
    offsetAndMetadata.commitTimestamp match {
        case -1L => false  // 从未提交，不过期
        case commitTime =>
            (now - commitTime) > retentionMs
    }
}
```

### 清理任务

```scala
/**
 * Offset 清理任务
 * /
class OffsetCleanupTask(
    offsetManager: OffsetManager,
    config: OffsetManagerConfig
) extends ShutdownableThread("offset-cleaner") {

    override def doWork(): Unit = {
        // 1. 查找过期的 Offset
        val expiredOffsets = findExpiredOffsets()

        if (expiredOffsets.nonEmpty) {
            // 2. 从缓存删除
            expiredOffsets.foreach { case (gtp, _) =>
                offsetManager.removeCache(gtp)
            }

            // 3. 写入删除标记到 __consumer_offsets
            val tombstones = expiredOffsets.map { case (gtp, _) =>
                val key = buildOffsetKey(gtp.group, gtp.topicPartition)
                (key, null)  // null 表示墓碑消息
            }

            appendTombstones(tombstones)

            info(s"Cleaned ${expiredOffsets.size} expired offsets")
        }

        // 4. 等待下次执行
        val cleanupDelay = config.offsetsRetentionCheckIntervalMs
        time.sleep(cleanupDelay)
    }

    /**
     * 查找过期的 Offset
     * /
    private def findExpiredOffsets(): Map[GroupTopicPartition, OffsetAndMetadata] = {
        val now = time.milliseconds()
        val expired = mutable.Map[GroupTopicPartition, OffsetAndMetadata]()

        offsetManager.offsetCache.foreach { case (gtp, offsetAndMetadata) =>
            if (isOffsetExpired(offsetAndMetadata, now)) {
                expired(gtp) = offsetAndMetadata
            }
        }

        expired.toMap
    }

    /**
     * 写入墓碑消息
     * /
    private def appendTombstones(
        tombstones: Map[Array[Byte], Array[Byte]]
    ): Unit = {
        // 构建批量删除记录
        val records = tombstones.map { case (key, value) =>
            new SimpleRecord(time.milliseconds(), key, value)
        }

        // 写入日志
        val logRecords = MemoryRecords.withRecords(
            CompressionType.NONE,
            records.toSeq: _*
        )

        replicaManager.appendRecords(
            timeout = config.offsetsTopicSegmentBytes,
            requiredAcks = -1,
            internalTopicsAllowed = true,
            isFromClient = false,
            entriesPerPartition = ...
        )
    }
}
```

## 5.7 Offset 提交策略

### 自动提交

```scala
/**
 * 自动提交模式:
 *
 * enable.auto.commit = true (默认)
 * auto.commit.interval.ms = 5000 (默认)
 *
 * 特点:
 * - Kafka 客户端定期提交
 * - 不需要手动控制
 * - 可能导致消息丢失或重复
 * /

// 消费者端自动提交
class KafkaConsumer<K, V> {
    private val autoCommitScheduler = new ScheduledThreadPoolExecutor(1)

    def enableAutoCommit(): Unit = {
        autoCommitScheduler.scheduleAtFixedRate(
            new Runnable {
                def run(): Unit = {
                    // 提交上次 poll 的位置
                    commitAsync(
                        new OffsetCommitCallback {
                            def onComplete(
                                offsets: Map[TopicPartition, OffsetAndMetadata],
                                exception: Exception
                            ): Unit = {
                                if (exception != null) {
                                    error("Auto commit failed", exception)
                                }
                            }
                        }
                    )
                }
            },
            autoCommitIntervalMs,
            autoCommitIntervalMs,
            TimeUnit.MILLISECONDS
        )
    }
}
```

### 手动提交

```scala
/**
 * 手动提交模式:
 *
 * enable.auto.commit = false
 *
 * 特点:
 * - 应用程序控制提交时机
 * - 可以实现精确一次语义
 * - 需要处理提交失败
 * /

// 同步提交
def processMessages(): Unit = {
    val records = consumer.poll(Duration.ofMillis(1000))

    try {
        // 处理消息
        records.forEach { record =>
            process(record)
        }

        // 处理完成后提交
        consumer.commitSync()
    } catch {
        case e: Exception =>
            // 处理失败，不提交
            error("Processing failed, will retry", e)
    }
}

// 异步提交
def processMessagesAsync(): Unit = {
    val records = consumer.poll(Duration.ofMillis(1000))

    // 处理消息
    records.forEach { record =>
        process(record)
    }

    // 异步提交
    consumer.commitAsync(new OffsetCommitCallback {
        def onComplete(
            offsets: Map[TopicPartition, OffsetAndMetadata],
            exception: Exception
        ): Unit = {
            if (exception != null) {
                error("Async commit failed", exception)
                // 可以加入重试队列
            }
        }
    })
}
```

### 按分区提交

```scala
/**
 * 按分区提交:
 *
 * 每个分区单独管理提交
 * 更细粒度的控制
 * /
def processWithPartitionCommit(): Unit = {
    val records = consumer.poll(Duration.ofMillis(1000))

    val processedOffsets = mutable.Map[TopicPartition, OffsetAndMetadata]()

    records.partitions().forEach { tp =>
        val partitionRecords = records.records(tp)

        try {
            // 处理该分区的消息
            partitionRecords.forEach { record =>
                process(record)
            }

            // 记录处理位置
            val lastOffset = partitionRecords.get(partitionRecords.size() - 1).offset()
            processedOffsets(tp) = new OffsetAndMetadata(lastOffset + 1)

            // 提交该分区
            consumer.commitSync(
                Collections.singletonMap(tp,
                    new OffsetAndMetadata(lastOffset + 1))
            )
        } catch {
            case e: Exception =>
                error(s"Failed to process $tp", e)
                // 不提交该分区
        }
    }
}
```

## 5.8 Offset 初始化与重置

### Offset 初始化策略

```scala
/**
 * Offset 初始化策略:
 *
 * auto.offset.reset (默认 latest)
 *
 * 可选值:
 * 1. earliest - 从最早的消息开始
 * 2. latest - 从最新的消息开始 (默认)
 * 3. none - 如果没有 Offset 则报错
 * 4. anything else - 抛出异常
 * /

// 查找初始位置
def findInitialPosition(
    topicPartition: TopicPartition,
    strategy: String
): Long = {
    strategy match {
        case "earliest" =>
            // 查找最早的 Offset
            getEarliestOffset(topicPartition)

        case "latest" =>
            // 查找最新的 Offset
            getLatestOffset(topicPartition)

        case "none" =>
            // 抛出异常
            throw new NoOffsetForPartitionException(
                s"No offset found for $topicPartition"
            )

        case _ =>
            throw new ConfigException(
                s"Invalid offset reset strategy: $strategy"
            )
    }
}
```

### Offset 重置操作

```scala
/**
 * 重置 Offset 到指定位置
 * /
def resetOffset(
    groupId: String,
    topicPartition: TopicPartition,
    newPosition: Long
): Unit = {
    // 1. 验证位置有效性
    val validOffsets = getLogOffsets(topicPartition)
    if (newPosition < validOffsets.earliest || newPosition > validOffsets.latest) {
        throw new OffsetOutOfRangeException(
            s"Offset $newPosition is out of range"
        )
    }

    // 2. 构建新的 Offset 元数据
    val offsetAndMetadata = OffsetAndMetadata(
        offset = newPosition,
        leaderEpoch = None,
        metadata = "reset",
        commitTimestamp = time.milliseconds()
    )

    // 3. 提交新的 Offset
    handleOffsetCommit(
        groupId = groupId,
        generationId = -1,  // 重置时代数不重要
        memberId = "",
        commits = Map(topicPartition -> offsetAndMetadata)
    )

    info(s"Reset offset for $topicPartition to $newPosition")
}

/**
 * 重置到最早
 * /
def resetToEarliest(
    groupId: String,
    topicPartition: TopicPartition
): Unit = {
    val earliest = getEarliestOffset(topicPartition)
    resetOffset(groupId, topicPartition, earliest)
}

/**
 * 重置到最新
 * /
def resetToLatest(
    groupId: String,
    topicPartition: TopicPartition
): Unit = {
    val latest = getLatestOffset(topicPartition)
    resetOffset(groupId, topicPartition, latest)
}
```

## 5.9 实战最佳实践

### 提交频率选择

```scala
/**
 * 提交频率建议:
 *
 * 高频提交 (每条消息):
 * - 优点: 重复消费少
 * - 缺点: 性能开销大
 * - 适用: 重要消息
 *
 * 中频提交 (每批次):
 * - 优点: 平衡性能和可靠性
 * - 缺点: 可能重复一批
 * - 适用: 大多数场景
 *
 * 低频提交 (定时):
 * - 优点: 性能开销小
 * - 缺点: 重复消费多
 * - 适用: 对重复不敏感
 * /
```

### 处理提交失败

```scala
/**
 * 提交失败处理策略:
 *
 * 1. 同步提交 + 重试
 * - 简单可靠
 * - 可能阻塞处理
 *
 * 2. 异步提交 + 回调
 * - 性能好
 * - 需要处理失败
 *
 * 3. 记录失败位置
 * - 后续补偿
 * - 实现复杂
 * /

// 同步提交 + 重试
def commitWithRetry(
    offsets: Map[TopicPartition, OffsetAndMetadata],
    maxRetries: Int = 3
): Unit = {
    var attempts = 0
    var success = false

    while (attempts < maxRetries && !success) {
        try {
            consumer.commitSync(offsets)
            success = true
        } catch {
            case e: RetriableException =>
                attempts += 1
                warn(s"Commit failed, retrying ($attempts/$maxRetries)", e)
                Thread.sleep(100)
            case e: Exception =>
                error("Commit failed with non-retriable exception", e)
                throw e
        }
    }
}
```

### 幂等处理

```scala
/**
 * 幂等处理:
 *
 * 防止重复消费导致的问题
 * /
def processIdempotent(
    consumerRecord: ConsumerRecord[Array[Byte], Array[Byte]]
): Unit = {
    // 1. 提取消息唯一标识
    val messageId = extractMessageId(consumerRecord)

    // 2. 检查是否已处理
    if (isProcessed(messageId)) {
        info(s"Message $messageId already processed, skipping")
        return
    }

    // 3. 处理消息
    try {
        processMessage(consumerRecord)

        // 4. 标记为已处理
        markAsProcessed(messageId)
    } catch {
        case e: Exception =>
            error(s"Failed to process message $messageId", e)
            // 可以重试或进入死信队列
    }
}

// 基于数据库的幂等性
def isProcessed(messageId: String): Boolean = {
    // 查询数据库
    database.query(
        "SELECT COUNT(*) FROM processed_messages WHERE id = ?",
        messageId
    ).map(_.getInt(1) > 0).getOrElse(false)
}
```

## 5.10 小结

Offset 管理是 Kafka 消费语义的核心，关键要点：

1. **存储机制**：__consumer_offsets Topic 提供高可用存储
2. **提交策略**：根据业务场景选择自动或手动提交
3. **缓存优化**：内存缓存提升查询性能
4. **过期清理**：定期清理过期 Offset 节省存储
5. **最佳实践**：幂等处理、重试机制、合理频率

## 参考文档

- [01-coordinator-overview.md](./01-coordinator-overview.md) - Coordinator 概述
- [02-group-management.md](./02-group-management.md) - Consumer Group 管理
- [10-coordinator-troubleshooting.md](./10-coordinator-troubleshooting.md) - 故障排查
