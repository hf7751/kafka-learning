# 10. 故障排查

## 10.1 常见问题概览

### 问题分类

```scala
/**
 * GroupCoordinator 常见问题分类:
 *
 * 1. Rebalance 问题
 *    - 频繁 Rebalance
 *    - Rebalance 超时
 *    - Rebalance 失败
 *
 * 2. 连接问题
 *    - Coordinator 不可用
 *    - 网络连接超时
 *    - 认证失败
 *
 * 3. Offset 问题
 *    - 提交失败
 *    - 重复消费
 *    - 消息丢失
 *
 * 4. 性能问题
 *    - 消费延迟
 *    - 吞吐量低
 *    - 资源占用高
 */
```

## 10.2 Rebalance 问题

### 问题 1: 频繁 Rebalance

#### 现象

```scala
/**
 * 现象:
 * 1. 日志显示频繁的 Rebalance
 * 2. 消费者频繁停止和恢复
 * 3. 消费性能下降
 * 4. 重复消费增加
 */

// 日志示例
// [2024-03-01 10:00:00] INFO: Group test-group preparing for rebalance
// [2024-03-01 10:00:10] INFO: Group test-group preparing for rebalance
// [2024-03-01 10:00:20] INFO: Group test-group preparing for rebalance
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查 Rebalance 原因
def diagnoseRebalanceCause(groupId: String): String = {
    val group = getGroup(groupId)

    // 1.1 检查成员变化
    val memberChanges = analyzeMemberChanges(group)
    if (memberChanges.frequent) {
        return "成员频繁变化: 检查消费者稳定性"
    }

    // 1.2 检查心跳超时
    val heartbeatIssues = analyzeHeartbeatIssues(group)
    if (heartbeatIssues.frequent) {
        return s"心跳超时: 检查 session.timeout (${heartbeatIssues.timeoutMs}ms)"
    }

    // 1.3 检查处理时间
    val processingTime = analyzeProcessingTime(group)
    if (processingTime > maxPollInterval) {
        return s"处理超时: 处理时间 (${processingTime}ms) 超过 max.poll.interval"
    }

    // 1.4 检查订阅变化
    val subscriptionChanges = analyzeSubscriptionChanges(group)
    if (subscriptionChanges.changes > 0) {
        return "订阅变化: 检查 Topic 分区数变化"
    }

    "未知原因: 需要进一步分析"
}

// 步骤 2: 检查配置
def checkRebalanceConfig(consumerConfig: Properties): List[String] = {
    val issues = mutable.ListBuffer[String]()

    val sessionTimeout = consumerConfig.getProperty(
        ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG,
        "45000"
    ).toInt

    val heartbeatInterval = consumerConfig.getProperty(
        ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG,
        "3000"
    ).toInt

    val maxPollInterval = consumerConfig.getProperty(
        ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG,
        "300000"
    ).toInt

    // 检查心跳间隔
    if (heartbeatInterval > sessionTimeout / 3) {
        issues += s"心跳间隔 (${heartbeatInterval}ms) 应该小于 session.timeout/3"
    }

    // 检查处理时间
    val avgProcessingTime = measureAvgProcessingTime()
    if (avgProcessingTime > maxPollInterval * 0.8) {
        issues += s"处理时间接近 max.poll.interval，建议增加 max.poll.interval"
    }

    issues.toList
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 调整超时配置
 */
properties.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
properties.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")
properties.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "600000")

/**
 * 2. 使用静态成员
 */
properties.put(ConsumerConfig.GROUP_INSTANCE_ID_CONFIG, "consumer-1")

/**
 * 3. 优化消息处理
 * - 减少处理时间
 * - 异步处理
 * - 增加并发
 */

/**
 * 4. 检查网络
 * - 网络延迟
 * - 丢包率
 * - 带宽限制
 */
```

### 问题 2: Rebalance 超时

#### 现象

```scala
/**
 * 现象:
 * 1. Rebalance 长时间不完成
 * 2. 组停留在 PreparingRebalance
 * 3. 消费者无法加入
 * 4. 日志显示等待成员
 */

// 日志示例
// [2024-03-01 10:00:00] INFO: Group test-group preparing for rebalance
// [2024-03-01 10:05:00] WARN: Group test-group rebalance timeout
// [2024-03-01 10:10:00] INFO: Group test-group still preparing for rebalance
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查成员状态
def checkMemberStatus(groupId: String): MemberStatusReport = {
    val group = getGroup(groupId)

    val members = group.members.values.map { member =>
        MemberInfo(
            memberId = member.memberId,
            clientId = member.clientId,
            clientHost = member.clientHost,
            hasJoined = member.hasRequestedJoin,
            lastHeartbeat = member.lastHeartbeatTimestamp,
            isExpired = isMemberExpired(member)
        )
    }.toList

    val allJoined = members.forall(_.hasJoined)
    val expiredCount = members.count(_.isExpired)

    MemberStatusReport(
        memberCount = members.size,
        allJoined = allJoined,
        expiredCount = expiredCount,
        members = members
    )
}

// 步骤 2: 检查网络连接
def checkNetworkConnectivity(consumer: KafkaConsumer[_, _]): NetworkReport = {
    val brokerAddresses = consumer
        .assignment()
        .asScala
        .flatMap { tp =>
            consumer.partitionsFor(tp.topic()).asScala
        }
        .map(_.leader())
        .toSet

    val reachable = brokerAddresses.forall { node =>
        try {
            testConnection(node.host(), node.port())
            true
        } catch {
            case _: Exception => false
        }
    }

    NetworkReport(
        totalBrokers = brokerAddresses.size,
        reachableCount = brokerAddresses.count(_ => reachable),
        reachable = reachable
    )
}

// 步骤 3: 检查 Coordinator 状态
def checkCoordinatorStatus(groupId: String): CoordinatorStatus = {
    val coordinator = findCoordinator(groupId)

    CoordinatorStatus(
        brokerId = coordinator.id(),
        host = coordinator.host(),
        port = coordinator.port(),
        isAlive = isBrokerAlive(coordinator.id())
    )
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 增加 rebalance.timeout.ms
 */
properties.put(ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG, "60000")

/**
 * 2. 排查网络问题
 */
// 使用 telnet 测试连接
// telnet broker-host 9092

/**
 * 3. 检查并修复失联成员
 */
// 重启失联的消费者
// 或等待超时后自动移除

/**
 * 4. 强制完成 Rebalance (最后手段)
 */
// 通过工具移除卡住的成员
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --reset-offsets \
  --to-earliest \
  --execute
```

### 问题 3: 无法加入组

#### 现象

```scala
/**
 * 现象:
 * 1. 消费者启动失败
 * 2. 日志显示 "MemberId required"
 * 3. 或显示 "Illegal generation"
 * 4. 或显示 "Unknown member id"
 */
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查 Group ID
def checkGroupId(config: Properties): Boolean = {
    val groupId = config.getProperty(ConsumerConfig.GROUP_ID_CONFIG)

    if (groupId == null || groupId.isEmpty) {
        error("Group ID 未配置")
        return false
    }

    true
}

// 步骤 2: 检查组状态
def checkGroupState(groupId: String): String = {
    val group = getGroup(groupId)

    if (group == null) {
        return "组不存在，将创建新组"
    }

    group.currentState match {
        case Dead => "组已死亡，需要删除并重建"
        case Empty => "组为空，可以加入"
        case PreparingRebalance => "组正在 Rebalance，请等待"
        case CompletingRebalance => "组正在完成 Rebalance，请等待"
        case Stable => "组稳定，可以加入"
    }
}

// 步骤 3: 检查代数
def checkGeneration(
    groupId: String,
    consumerGeneration: Int
): GenerationCheckResult = {
    val group = getGroup(groupId)

    val serverGeneration = group.generationId

    GenerationCheckResult(
        consumerGeneration = consumerGeneration,
        serverGeneration = serverGeneration,
        matched = consumerGeneration == serverGeneration,
        action = if (consumerGeneration != serverGeneration) {
            "需要重新加入组"
        } else {
            "正常"
        }
    )
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 重新加入组
 */
consumer.unsubscribe()
consumer.subscribe(Collections.singletonList("test-topic"))
// 或
consumer.assign(partitions)

/**
 * 2. 重置 Offset (如果需要)
 */
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --reset-offsets \
  --to-earliest \
  --execute

/**
 * 3. 删除并重建组 (极端情况)
 */
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --delete
```

## 10.3 Offset 问题

### 问题 1: Offset 提交失败

#### 现象

```scala
/**
 * 现象:
 * 1. 日志显示 "Commit failed"
 * 2. Offset 提交超时
 * 3. 出现重复消费
 */

// 日志示例
// [2024-03-01 10:00:00] WARN: Commit of offset {test-topic-0=12345} failed
// [2024-03-01 10:00:00] ERROR: Offset commit failed: Commit cannot be completed
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查 __consumer_offsets Topic
def checkOffsetsTopic(): OffsetsTopicStatus = {
    val topic = "__consumer_offsets"

    // 检查 Topic 是否存在
    val exists = adminClient.listTopics().names().get().contains(topic)

    if (!exists) {
        return OffsetsTopicStatus(exists = false, error = "Topic 不存在")
    }

    // 检查分区状态
    val partitions = adminClient
        .describeTopics()
        .allTopics()
        .get()
        .get(topic)
        .partitions()

    val offlinePartitions = partitions.asScala.count { p =>
        p.leader() == null || p.leader().id() == -1
    }

    if (offlinePartitions > 0) {
        return OffsetsTopicStatus(
            exists = true,
            error = s"有 $offlinePartitions 个分区离线"
        )
    }

    OffsetsTopicStatus(exists = true, healthy = true)
}

// 步骤 2: 检查权限
def checkOffsetCommitPermissions(
    groupId: String,
    principal: String
): PermissionStatus = {
    // 检查是否有写入 __consumer_offsets 的权限
    val hasPermission = checkAcl(
        principal = principal,
        resource = Topic("__consumer_offsets"),
        operation = WRITE
    )

    PermissionStatus(
        hasPermission = hasPermission,
        missingPermission = if (!hasPermission) Some("WRITE") else None
    )
}

// 步骤 3: 检查 Coordinator 可用性
def checkCoordinatorAvailability(groupId: String): CoordinatorAvailability = {
    val coordinator = findCoordinator(groupId)

    val available = try {
        val request = new FindCoordinatorRequest(
            FindCoordinatorRequest.CoordinatorType.GROUP,
            groupId
        )
        val response = adminClient.findCoordinator(request)
        response.coordinator() != null
    } catch {
        case _: Exception => false
    }

    CoordinatorAvailability(
        available = available,
        coordinator = if (available) Some(coordinator) else None
    )
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 创建 __consumer_offsets Topic (如果不存在)
 */
kafka-topics --bootstrap-server localhost:9092 \
  --topic __consumer_offsets \
  --create \
  --partitions 50 \
  --replication-factor 3 \
  --config cleanup.policy=compact \
  --config segment.bytes=104857600

/**
 * 2. 修复离线分区
 */
kafka-reassign-partitions --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --execute

/**
 * 3. 配置 ACL 权限
 */
kafka-acls --bootstrap-server localhost:9092 \
  --add \
  --allow-principal User:consumer-user \
  --operation WRITE \
  --topic __consumer_offsets

/**
 * 4. 使用异步提交 + 重试
 */
consumer.commitAsync(
    offsets,
    new OffsetCommitCallback {
        def onComplete(
            offsets: Map[TopicPartition, OffsetAndMetadata],
            exception: Exception
        ): Unit = {
            if (exception != null) {
                // 加入重试队列
                retryQueue.offer(offsets)
            }
        }
    }
)
```

### 问题 2: 重复消费

#### 现象

```scala
/**
 * 现象:
 * 1. 数据重复处理
 * 2. 数据库有重复记录
 * 3. 业务逻辑异常
 */
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查消费位置
def checkConsumerPosition(
    groupId: String,
    topicPartition: TopicPartition
): ConsumerPositionInfo = {
    // 1. 获取提交的 Offset
    val committedOffset = getCommittedOffset(groupId, topicPartition)

    // 2. 获取最新 Offset
    val latestOffset = getLatestOffset(topicPartition)

    // 3. 获取处理中的 Offset
    val processingOffset = getProcessingOffset(groupId, topicPartition)

    ConsumerPositionInfo(
        committed = committedOffset,
        latest = latestOffset,
        processing = processingOffset,
        lag = latestOffset - committedOffset
    )
}

// 步骤 2: 检查重复消费原因
def diagnoseDuplicateConsumption(
    groupId: String,
    topicPartition: TopicPartition
): DuplicateConsumptionCause = {
    val position = checkConsumerPosition(groupId, topicPartition)

    if (position.processing < position.committed) {
        return DuplicateConsumptionCause(
            cause = "处理回滚",
            description = "消费者处理失败，回滚到已提交的位置"
        )
    }

    if (hasRebalanceHappenedRecently(groupId)) {
        return DuplicateConsumptionCause(
            cause = "Rebalance",
            description = "Rebalance 导致重新从上次提交位置开始"
        )
    }

    if (isAutoCommitEnabled(groupId)) {
        return DuplicateConsumptionCause(
            cause = "自动提交",
            description = "自动提交间隔过长，处理失败后重复"
        )
    }

    DuplicateConsumptionCause(
        cause = "未知",
        description = "需要进一步调查"
    )
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 使用手动提交
 */
properties.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")

// 处理完成后提交
try {
    processRecords(records)
    consumer.commitSync()
} catch {
    case e: Exception =>
    // 不提交，下次重新处理
}

/**
 * 2. 实现幂等处理
 */
def processIdempotent(record: ConsumerRecord[String, String]): Unit = {
    val messageId = extractMessageId(record)

    // 检查是否已处理
    if (isProcessed(messageId)) {
        logger.info(s"Message $messageId already processed, skipping")
        return
    }

    try {
        // 处理消息
        processMessage(record)

        // 标记为已处理
        markAsProcessed(messageId)

    } catch {
        case e: Exception =>
            logger.error(s"Failed to process message $messageId", e)
            throw e
    }
}

/**
 * 3. 使用事务 (精确一次)
 */
// 生产者使用事务
producer.initTransactions()

try {
    producer.beginTransaction()

    // 消费并处理
    val records = consumer.poll(Duration.ofMillis(1000))
    records.forEach { record =>
        val result = process(record)

        // 发送结果到下游
        producer.send(new ProducerRecord("output-topic", result))
    }

    // 提交消费 Offset 和生产结果
    sendOffsetsToTransaction(
        consumer.position(),
        consumer.groupMetadata()
    )

    producer.commitTransaction()

} catch {
    case e: Exception =>
    producer.abortTransaction()
}
```

### 问题 3: 消息丢失

#### 现象

```scala
/**
 * 现象:
 * 1. 数据缺失
 * 2. 业务逻辑异常
 * 3. 对账失败
 */
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 检查消费位置
def checkForMissingMessages(
    groupId: String,
    topicPartition: TopicPartition,
    startOffset: Long,
    endOffset: Long
): MissingMessagesReport = {
    // 1. 检查已提交的 Offset
    val committedOffset = getCommittedOffset(groupId, topicPartition)

    // 2. 检查是否有跳跃
    val previousCommitted = getPreviousCommittedOffset(groupId, topicPartition)

    val gap = if (previousCommitted.isDefined &&
                  committedOffset > previousCommitted.get + 1) {
        Some((previousCommitted.get + 1) until committedOffset)
    } else {
        None
    }

    MissingMessagesReport(
        committedOffset = committedOffset,
        previousOffset = previousCommitted,
        gap = gap,
        hasGap = gap.isDefined
    )
}

// 步骤 2: 检查消费逻辑
def checkConsumerLogic(
    consumerRecords: ConsumerRecords[String, String]
): ConsumerLogicReport = {
    val issues = mutable.ListBuffer[String]()

    // 检查是否正确处理所有记录
    val recordCount = consumerRecords.count()
    val processedCount = // ... 实际处理的数量

    if (processedCount < recordCount) {
        issues += s"处理数量 ($processedCount) 少于记录数量 ($recordCount)"
    }

    // 检查异常处理
    val hasExceptionHandling = // ... 检查异常处理逻辑
    if (!hasExceptionHandling) {
        issues += "缺少异常处理，可能导致消息丢失"
    }

    ConsumerLogicReport(
        recordCount = recordCount,
        processedCount = processedCount,
        issues = issues.toList
    )
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 确保所有消息都被处理
 */
def processAllRecords(records: ConsumerRecords[String, String]): Unit = {
    try {
        records.partitions().asScala.foreach { tp =>
            val partitionRecords = records.records(tp)

            // 处理每条记录
            partitionRecords.asScala.foreach { record =>
                try {
                    processRecord(record)
                } catch {
                    case e: Exception =>
                        // 记录失败，继续处理下一条
                        // 根据业务需求决定是否重试
                        error(s"Failed to process record $record", e)
                }
            }
        }

        // 所有记录处理完成后提交
        consumer.commitSync()

    } catch {
        case e: Exception =>
        // 不提交，下次重新处理
        error("Batch processing failed", e)
    }
}

/**
 * 2. 先提交再处理 (至少一次)
 */
try {
    // 先提交 Offset
    consumer.commitSync()

    // 再处理消息
    processRecords(records)

} catch {
    case e: Exception =>
    // 处理失败，但 Offset 已提交
    // 需要补偿机制处理重复
}

/**
 * 3. 使用数据库事务
 */
def processWithTransaction(
    record: ConsumerRecord[String, String]
): Unit = {
    val connection = dataSource.getConnection()
    try {
        connection.setAutoCommit(false)

        // 1. 插入处理记录
        insertProcessingRecord(connection, record)

        // 2. 处理业务逻辑
        processBusinessLogic(connection, record)

        // 3. 更新处理状态
        updateProcessingStatus(connection, record, "SUCCESS")

        connection.commit()

    } catch {
        case e: Exception =>
        connection.rollback()
        throw e
    } finally {
        connection.close()
    }

    // 数据库事务成功后提交 Kafka Offset
    consumer.commitSync()
}
```

## 10.4 性能问题

### 问题 1: 消费延迟

#### 现象

```scala
/**
 * 现象:
 * 1. 消费 Lag 增大
 * 2. 处理速度 < 生产速度
 * 3. 消息积压
 */
```

#### 排查步骤

```scala
/**
 * 排查步骤:
 */

// 步骤 1: 测量消费延迟
def measureConsumerLag(
    groupId: String,
    topicPartitions: Set[TopicPartition]
): LagReport = {
    val lags = topicPartitions.map { tp =>
        val committed = getCommittedOffset(groupId, tp)
        val latest = getLatestOffset(tp)
        val lag = latest - committed.offset()

        tp -> PartitionLag(
            committed = committed.offset(),
            latest = latest,
            lag = lag
        )
    }.toMap

    val totalLag = lags.values.map(_.lag).sum

    LagReport(
        partitionLags = lags,
        totalLag = totalLag,
        affectedPartitions = lags.values.count(_.lag > 0)
    )
}

// 步骤 2: 分析性能瓶颈
def analyzePerformanceBottleneck(
    groupId: String
): PerformanceBottleneck = {
    // 1. 检查处理时间
    val avgProcessingTime = measureAvgProcessingTime()

    // 2. 检查网络 I/O
    val networkBandwidth = measureNetworkBandwidth()

    // 3. 检查磁盘 I/O
    val diskIO = measureDiskIO()

    // 4. 检查 CPU 使用率
    val cpuUsage = measureCPUUsage()

    PerformanceBottleneck(
        avgProcessingTime = avgProcessingTime,
        networkBandwidth = networkBandwidth,
        diskIO = diskIO,
        cpuUsage = cpuUsage,
        likelyBottleneck = determineBottleneck(
            avgProcessingTime,
            networkBandwidth,
            diskIO,
            cpuUsage
        )
    )
}

private def determineBottleneck(
    processingTime: Long,
    network: Double,
    disk: Double,
    cpu: Double
): String = {
    if (processingTime > 1000) "处理时间过长"
    else if (network > 0.8) "网络带宽不足"
    else if (disk > 0.8) "磁盘 I/O 过高"
    else if (cpu > 0.8) "CPU 使用率过高"
    else "需要进一步分析"
}
```

#### 解决方案

```scala
/**
 * 解决方案:
 *
 * 1. 增加消费者数量
 */
// 增加消费者实例
// 确保消费者数 <= 分区数

/**
 * 2. 增加分区数
 */
kafka-topics --bootstrap-server localhost:9092 \
  --topic test-topic \
  --alter \
  --partitions 20

/**
 * 3. 优化处理逻辑
 * - 减少处理时间
 * - 增加并发
 * - 使用批处理
 */

/**
 * 4. 增加拉取数量
 */
properties.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "1000")

/**
 * 5. 增加拉取大小
 */
properties.put(ConsumerConfig.FETCH_MAX_BYTES_CONFIG, "52428800")  // 50MB
properties.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "102400")   // 100KB
```

### 问题 2: 吞吐量低

#### 现象

```scala
/**
 * 现象:
 * 1. 消费速度慢
 * 2. 资源利用率低
 * 3. 延迟不大但吞吐量小
 */
```

#### 排查与解决

```scala
/**
 * 解决方案:
 *
 * 1. 增加并发
 */
properties.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "2000")

val executor = Executors.newFixedThreadPool(10)

val records = consumer.poll(Duration.ofMillis(1000))
val futures = records.asScala.map { record =>
    executor.submit(new Callable[Unit] {
        def call(): Unit = processRecord(record)
    })
}

futures.foreach(_.get())

/**
 * 2. 批量处理
 */
def processBatch(records: ConsumerRecords[String, String]): Unit = {
    // 批量插入数据库
    val batch = new BatchStatement()
    records.asScala.foreach { record =>
        batch.add(buildInsertStatement(record))
    }
    database.execute(batch)

    // 批量提交
    consumer.commitSync()
}

/**
 * 3. 调整拉取参数
 */
properties.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1024000")  // 1MB
properties.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "500")    // 500ms
```

## 10.5 诊断工具

### 命令行工具

```bash
# 1. 查看组详情
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --describe

# 2. 重置 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --topic test-topic \
  --reset-offsets \
  --to-earliest \
  --execute

# 3. 删除组
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --delete

# 4. 导出 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --export \
  --offsets-file offsets.json

# 5. 导入 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group test-group \
  --import \
  --offsets-file offsets.json
```

### 监控指标

```scala
/**
 * 关键监控指标
 */
object CoordinatorMetrics {
    // Rebalance 指标
    val REBALANCE_RATE = "kafka.consumer:type=consumer-coordinator-metrics,client-id=*"
    val REBALANCE_TIME_AVG = "rebalance-time-avg"
    val REBALANCE_TIME_MAX = "rebalance-time-max"
    val REBALANCE_TIME_TOTAL = "rebalance-time-total"

    // 延迟指标
    val CONSUMER_LAG = "consumer-lag"
    val RECORDS_LAG_MAX = "records-lag-max"
    val RECORDS_LAG_AVG = "records-lag-avg"

    // 性能指标
    val RECORDS_PER_SEC = "records-consumed-rate"
    val BYTES_PER_SEC = "bytes-consumed-rate"
    val FETCH_LATENCY_AVG = "fetch-latency-avg"

    // 错误指标
    val COMMIT_FAILURE_RATE = "commit-failure-rate"
    val HEARTBEAT_FAILURE_RATE = "heartbeat-failure-rate"
}
```

## 10.6 小结

故障排查是运维工作的核心，关键要点：

1. **系统化排查**：按照步骤逐一排查
2. **日志分析**：充分利用日志信息
3. **监控指标**：建立完善的监控体系
4. **工具使用**：熟练使用命令行和监控工具
5. **经验积累**：记录和分享故障案例

## 参考文档

- [08-rebalance-optimization.md](./08-rebalance-optimization.md) - Rebalance 优化
- [09-coordinator-monitoring.md](./09-coordinator-monitoring.md) - 监控指标
- [11-coordinator-config.md](./11-coordinator-config.md) - 配置详解
