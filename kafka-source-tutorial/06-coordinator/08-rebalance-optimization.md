# 08. Rebalance 优化

## 8.1 优化目标

```scala
/**
 * Rebalance 优化目标:
 *
 * 1. 减少 Rebalance 频率
 *    - 降低不必要的 Rebalance
 *    - 提高系统稳定性
 *
 * 2. 缩短 Rebalance 时间
 *    - 减少消费暂停
 *    - 降低重复消费
 *
 * 3. 降低 Rebalance 影响
 *    - 最小化分区转移
 *    - 保持消费语义
 *
 * 4. 提升系统健壮性
 *    - 容忍网络抖动
 *    - 适应流量波动
 * /
```

## 8.2 静态成员优化

### 原理

```scala
/**
 * 静态成员机制:
 *
 * 问题:
 * - 容器重启导致成员身份变化
 * - 网络抖动触发 Rebalance
 * - Session 过度敏感
 *
 * 解决:
 * - 使用 group.instance.id 标识成员
 * - 成员重连后保持身份
 * - 减少 Rebalance 次数
 * /
```

### 配置示例

```scala
/**
 * 静态成员配置
 * /
val props = new Properties()
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092")
props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-group")
props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
          classOf[StringDeserializer])
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
          classOf[StringDeserializer])

// 静态成员配置
props.put(ConsumerConfig.GROUP_INSTANCE_ID_CONFIG, "consumer-1")  // 关键配置
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

val consumer = new KafkaConsumer[String, String](props)
```

### 效果对比

```scala
/**
 * 优化效果对比:
 *
 * 场景: 容器重启 (1 分钟内恢复)
 *
 * 动态成员:
 * - Session 超时: 30s
 * - 触发 Rebalance: ✓
 * - 重新分配分区: ✓
 * - 恢复时间: 45s
 *
 * 静态成员:
 * - Session 超时: 30s (使用 max.poll.interval)
 * - 触发 Rebalance: ✗ (保留身份)
 * - 重新分配分区: ✗
 * - 恢复时间: 5s
 * /
```

## 8.3 超时配置优化

### 参数调优

```scala
/**
 * 超时参数调优策略
 * /

/**
 * 1. session.timeout.ms
 *
 * 作用: 心跳超时时间
 * 默认: 45000 (45s)
 * 范围: 1000 - 300000
 *
 * 调优建议:
 * - 网络稳定: 10-30s
 * - 网络不稳定: 30-60s
 * - 容器环境: 30s+
 *
 * 注意: heartbeat.interval 必须小于此值
 * /
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")

/**
 * 2. heartbeat.interval.ms
 *
 * 作用: 心跳发送间隔
 * 默认: 3000 (3s)
 * 范围: session.timeout.ms / 3
 *
 * 调优建议:
 * - 通常设置为 session.timeout.ms 的 1/3
 * - 频繁心跳: 更快检测故障
 * - 低频心跳: 减少 Coordinator 负载
 * /
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

/**
 * 3. max.poll.interval.ms
 *
 * 作用: 两次 poll 的最大间隔
 * 默认: 300000 (5 min)
 * 范围: 1 - Integer.MAX_VALUE
 *
 * 调优建议:
 * - 快速处理: 1-3 min
 * - 复杂处理: 5-10 min
 * - 批量处理: 10-30 min
 *
 * 注意: 超过此时间会被认为失效
 * /
props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000")

/**
 * 4. max.poll.records
 *
 * 作用: 单次 poll 最大记录数
 * 默认: 500
 * 范围: 1 - Integer.MAX_VALUE
 *
 * 调优建议:
 * - 快速处理: 100-300
 * - 普通处理: 500-1000
 * - 批量处理: 1000-5000
 *
 * 注意: 影响处理时间和 max.poll.interval
 * /
props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "500")

/**
 * 配置计算公式:
 *
 * 确保:
 * max.poll.records / processing_rate < max.poll.interval
 *
 * 示例:
 * - 处理速率: 1000 条/秒
 * - max.poll.records: 500
 * - 处理时间: 0.5 秒
 * - 安全系数: 10
 * - 建议 max.poll.interval: 5 秒
 * /
```

### 最佳实践配置

```scala
/**
 * 场景 1: 低延迟场景
 * /
object LowLatencyConfig {
    def apply(): Properties = {
        val props = new Properties()

        // 快速检测故障
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "10000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "3000")

        // 快速处理
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "60000")
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "100")

        props
    }
}

/**
 * 场景 2: 高吞吐场景
 * /
object HighThroughputConfig {
    def apply(): Properties = {
        val props = new Properties()

        // 容忍网络波动
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

        // 批量处理
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "600000")  // 10 分钟
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "2000")

        props
    }
}

/**
 * 场景 3: 容器环境
 * /
object ContainerEnvironmentConfig {
    def apply(instanceId: String): Properties = {
        val props = new Properties()

        // 静态成员
        props.put(ConsumerConfig.GROUP_INSTANCE_ID_CONFIG, instanceId)

        // 容忍重启
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "60000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "20000")

        // 充足的处理时间
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "600000")

        props
    }
}
```

## 8.4 分区分配策略优化

### 策略选择

```scala
/**
 * 分区分配策略选择
 * /

/**
 * 1. Range Assignor (默认)
 *
 * 适用场景:
 * - Topic 数量少
 * - 消费者数能整除分区数
 * - 需要连续的分区范围
 *
 * 优点:
 * - 简单直观
 * - 性能开销小
 *
 * 缺点:
 * - 可能不均匀
 * - Rebalance 影响大
 * /
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          classOf[RangeAssignor])

/**
 * 2. RoundRobin Assignor
 *
 * 适用场景:
 * - 多 Topic 订阅
 * - 需要均匀分配
 * - 不关心分区连续性
 *
 * 优点:
 * - 分配更均匀
 * - 负载均衡好
 *
 * 缺点:
 * - Rebalance 影响大
 * - 打乱分区连续性
 * /
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          classOf[RoundRobinAssignor])

/**
 * 3. Sticky Assignor
 *
 * 适用场景:
 * - 需要减少 Rebalance 影响
 * - 保持分区粘性
 * - 可接受复杂计算
 *
 * 优点:
 * - 最小化分区转移
 * - 减少 Rebalance 影响
 * - 保证均匀分配
 *
 * 缺点:
 * - 计算复杂
 * - 分配时间较长
 * /
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          classOf[StickyAssignor])

/**
 * 4. Cooperative Sticky Assignor (推荐)
 *
 * 适用场景:
 * - 需要渐进式 Rebalance
 * - 不能容忍消费暂停
 * - Kafka 2.4+
 *
 * 优点:
 * - 渐进式重分配
 * - 消费不中断
 * - 影响最小
 *
 * 缺点:
 * - 两阶段完成
 * - 状态管理复杂
 * /
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          classOf[CooperativeStickyAssignor])
```

### 自定义策略

```scala
/**
 * 自定义分区分配策略
 *
 * 场景: 基于主机名的分配
 * /
class HostnameAwareAssignor extends PartitionAssignor {
    override def name(): String = "hostname-aware"

    override def assign(
        ctx: AssignmentContext,
        members: List[MemberMetadata]
    ): Map[String, Assignment] = {
        // 1. 按主机名分组
        val membersByHost = members.groupBy { member =>
            extractHostname(member.clientHost)
        }

        // 2. 每个 rack 范围内分配
        val assignments = mutable.Map[String, Assignment]()

        ctx.subscribedTopics.foreach { topic =>
            val partitions = ctx.partitionsForTopic(topic)

            // 按 rack 分配
            membersByHost.foreach { case (host, hostMembers) =>
                val hostPartitions = selectPartitionsForRack(
                    partitions,
                    host,
                    membersByHost.size
                )

                // Range 分配给该 rack 的成员
                assignPartitionsToMembers(
                    hostMembers,
                    hostPartitions,
                    assignments
                )
            }
        }

        assignments.toMap
    }

    private def extractHostname(host: String): String = {
        // 提取主机名或 rack 信息
        host.split('.').head
    }

    private def selectPartitionsForRack(
        partitions: Seq[Partition],
        rack: String,
        numRacks: Int
    ): Seq[Partition] = {
        // 基于分区号选择
        // 例如: 分区 0,3,6... 分给 rack 0
        partitions.zipWithIndex.filter { case (_, idx) =>
            idx % numRacks == rack.hashCode % numRacks
        }.map { case (p, _) => p }
    }
}
```

## 8.5 消费处理优化

### 处理时间优化

```scala
/**
 * 优化消费处理时间
 *
 * 目标: 确保处理时间 < max.poll.interval
 * /

/**
 * 1. 批量处理
 * /
def processBatchOptimized(
    consumer: KafkaConsumer[String, String],
    maxProcessingTimeMs: Long
): Unit = {
    val startTime = System.currentTimeMillis()

    val records = consumer.poll(Duration.ofMillis(1000))

    try {
        // 并行处理
        val futures = records.asScala.map { record =>
            Future {
                processRecord(record)
            }
        }

        // 等待完成（带超时）
        val remainingTime = maxProcessingTimeMs -
                           (System.currentTimeMillis() - startTime)

        Await.result(
            Future.sequence(futures),
            Duration(remainingTime, TimeUnit.MILLISECONDS)
        )

        // 处理成功，提交
        consumer.commitSync()

    } catch {
        case e: TimeoutException =>
            // 处理超时，不提交
            error("Processing timeout, will retry", e)
            // 可以选择:
            // 1. 不提交，下次重新处理
            // 2. 提交部分处理的结果
            // 3. 将未处理的放入重试队列

        case e: Exception =>
            error("Processing failed", e)
            // 不提交，下次重新处理
    }
}

/**
 * 2. 异步处理 + Offset 管理
 * /
class AsyncProcessor(
    consumer: KafkaConsumer[String, String],
    executor: ExecutorService
) {
    private val pendingOffsets = mutable.Map[TopicPartition, OffsetAndMetadata]()
    private val pendingOffsetsLock = new ReentrantLock()

    def start(): Unit = {
        while (true) {
            val records = consumer.poll(Duration.ofMillis(1000))

            records.asScala.foreach { record =>
                // 异步处理
                executor.submit(new Runnable {
                    def run(): Unit = {
                        try {
                            processRecord(record)

                            // 处理成功，记录 Offset
                            val tp = new TopicPartition(record.topic(), record.partition())
                            val offset = new OffsetAndMetadata(record.offset() + 1)

                            pendingOffsetsLock.synchronized {
                                pendingOffsets(tp) = offset
                            }
                        } catch {
                            case e: Exception =>
                                error(s"Failed to process $record", e)
                                // 可以放入重试队列
                        }
                    }
                })
            }

            // 定期提交已处理的 Offset
            commitProcessedOffsets()
        }
    }

    def commitProcessedOffsets(): Unit = {
        pendingOffsetsLock.synchronized {
            if (pendingOffsets.nonEmpty) {
                try {
                    consumer.commitSync(pendingOffsets.toMap)
                    pendingOffsets.clear()
                } catch {
                    case e: Exception =>
                        error("Commit failed, will retry", e)
                }
            }
        }
    }
}
```

### 背压控制

```scala
/**
 * 背压控制
 *
 * 防止处理积压导致超时
 * /
class BackpressureController(
    maxPendingRecords: Int = 1000,
    targetProcessingTimeMs: Long = 100
) {
    private val pendingRecords = new AtomicInteger(0)
    private val currentPollRecords = new AtomicInteger(500)

    /**
     * 调整 poll 数量
     * /
    def adjustPollRecords(processingTimeMs: Long): Int = {
        if (processingTimeMs > targetProcessingTimeMs * 2) {
            // 处理太慢，减少 poll 数量
            val newRecords = Math.max(
                currentPollRecords.get() / 2,
                10
            )
            currentPollRecords.set(newRecords)
            warn(s"Reducing poll records to $newRecords due to slow processing")
        } else if (processingTimeMs < targetProcessingTimeMs / 2 &&
                  pendingRecords.get() < maxPendingRecords / 2) {
            // 处理很快，可以增加
            val newRecords = Math.min(
                currentPollRecords.get() * 2,
                1000
            )
            currentPollRecords.set(newRecords)
        }

        currentPollRecords.get()
    }

    def onPoll(recordCount: Int): Unit = {
        pendingRecords.addAndGet(recordCount)
    }

    def onProcess(recordCount: Int): Unit = {
        pendingRecords.addAndGet(-recordCount)
    }
}
```

## 8.6 Cooperative Rebalance 优化

### 启用配置

```scala
/**
 * 启用 Cooperative Rebalance
 * /
val props = new Properties()

// 使用 Cooperative Sticky Assignor
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          "org.apache.kafka.clients.consumer.CooperativeStickyAssignor")

// 其他配置保持不变
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")
props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000")

val consumer = new KafkaConsumer[String, String](props)
```

### 客户端处理

```scala
/**
 * Cooperative Rebalance 客户端处理
 *
 * 注意: 需要处理 onPartitionsRevoked 回调
 * /
class CooperativeConsumer {
    def createConsumer(): KafkaConsumer[String, String] = {
        val props = new Properties()
        // ... 配置

        val consumer = new KafkaConsumer[String, String](props)

        // 设置回调
        consumer.subscribe(
            Collections.singletonList("test-topic"),
            new ConsumerRebalanceListener {
                override def onPartitionsRevoked(
                    partitions: Collection[TopicPartition]
                ): Unit = {
                    // Cooperative 模式下，只释放要转移的分区
                    info(s"Partitions revoked: $partitions")

                    // 提交当前 Offset
                    consumer.commitSync()

                    // 完成当前处理
                    waitForPendingProcessing()
                }

                override def onPartitionsAssigned(
                    partitions: Collection[TopicPartition]
                ): Unit = {
                    // 获得新分配的分区
                    info(s"Partitions assigned: $partitions")

                    // 开始消费新分区
                    // 注意: 旧分区可能仍在消费
                }
            }
        )

        consumer
    }

    def waitForPendingProcessing(): Unit = {
        // 等待待处理的消息完成
        // 避免提交后还有消息在处理
    }
}
```

### 效果对比

```scala
/**
 * Eager vs Cooperative 对比
 *
 * 场景: 3 个消费者，6 个分区，新增 1 个消费者
 *
 * Eager Rebalance:
 * 1. 停止所有消费 (0s)
 * 2. Rebalance 开始 (0-10s)
 * 3. 重新分配 (10s)
 * 4. 恢复消费 (10s+)
 * 总暂停时间: ~10s
 * 影响分区: 6 个
 *
 * Cooperative Rebalance:
 * 阶段 1:
 * 1. 释放 2 个分区 (0s)
 * 2. 其他 4 个分区继续消费
 * 3. Rebalance 开始 (0-5s)
 * 阶段 2:
 * 4. 分配 2 个分区给新成员 (5s)
 * 总暂停时间: ~0s (渐进式)
 * 影响分区: 2 个
 * /
```

## 8.7 大规模组优化

### 组规模限制

```scala
/**
 * 大规模组的挑战
 *
 * 1. Rebalance 时间长
 *    - 需要协调所有成员
 *    - 分区分配计算复杂
 *
 * 2. Coordinator 负载高
 *    - 心跳处理量大
 *    - Offset 管理复杂
 *
 * 3. 故障影响大
 *    - 单个成员故障触发全局 Rebalance
 *    - 恢复时间长
 * /

/**
 * 优化策略:
 *
 * 1. 分组
 *    - 将大组拆分为多个小组
 *    - 每个 Topic 使用独立的组
 *    - 按业务域分组
 *
 * 2. 增加分区数
 *    - 分区数 > 成员数
 *    - 避免成员空闲
 *    - 提高并行度
 *
 * 3. 使用静态成员
 *    - 减少成员变化
 *    - 降低 Rebalance 频率
 * /
```

### 容量规划

```scala
/**
 * 容量规划建议
 * /

/**
 * 1. 单组成员数
 *
 * 建议: < 1000
 *
 * 原因:
 * - Rebalance 时间与成员数成正比
 * - 协调开销增加
 * - 故障概率增加
 *
 * 超过 1000: 考虑拆分
 * /
object GroupCapacityCalculator {
    def calculateOptimalMemberCount(
        partitionCount: Int,
        processingCapacity: Long
    ): Int = {
        // 1. 不能超过分区数
        val maxByPartitions = partitionCount

        // 2. 根据处理能力
        val maxByCapacity = (processingCapacity / 1000).toInt

        Math.min(maxByPartitions, maxByCapacity)
    }

    /**
     * 示例:
     * - 分区数: 100
     * - 处理能力: 50000 条/秒
     * - 建议成员数: min(100, 50) = 50
     * /
}

/**
 * 2. Coordinator 数量
 *
 * 建议: __consumer_offsets 分区数 >= (组数 / 100)
 *
 * 示例:
 * - 组数: 10000
 * - 建议分区数: 10000 / 100 = 100
 * /
object OffsetTopicCalculator {
    def calculateOptimalPartitions(
        groupCount: Int,
        targetGroupsPerPartition: Int = 100
    ): Int = {
        val partitions = groupCount / targetGroupsPerPartition

        // 向上取整到最近的 2 的幂
        nextPowerOfTwo(partitions)
    }

    private def nextPowerOfTwo(n: Int): Int = {
        if (n <= 2) return 2
        var power = 2
        while (power < n) {
            power *= 2
        }
        power
    }
}
```

## 8.8 监控与诊断

### 优化指标

```scala
/**
 * Rebalance 优化指标
 * /
case class RebalanceOptimizationMetrics(
    // 频率指标
    rebalanceCount: Long,                    // Rebalance 次数
    rebounceRate: Double,                    // Rebalance 频率 (次/分钟)
    avgRebalanceInterval: Long,              // 平均 Rebalance 间隔

    // 时间指标
    avgRebalanceTime: Long,                  // 平均 Rebalance 时间
    p95RebalanceTime: Long,                  // P95 Rebalance 时间
    p99RebalanceTime: Long,                  // P99 Rebalance 时间

    // 影响指标
    avgPartitionsMoved: Double,              // 平均移动分区数
    avgProcessingPauseTime: Long,            // 平均消费暂停时间

    // 成员指标
    avgMemberCount: Double,                  // 平均成员数
    memberChangeRate: Double,                // 成员变化率
)

/**
 * 采集优化指标
 * /
def collectOptimizationMetrics(
    group: GroupMetadata
): RebalanceOptimizationMetrics = {
    val rebalanceHistory = group.rebalanceHistory

    RebalanceOptimizationMetrics(
        rebalanceCount = rebalanceHistory.size,
        rebounceRate = calculateRebalanceRate(rebalanceHistory),
        avgRebalanceInterval = calculateAvgInterval(rebalanceHistory),
        avgRebalanceTime = calculateAvgRebalanceTime(rebalanceHistory),
        p95RebalanceTime = calculateP95RebalanceTime(rebalanceHistory),
        p99RebalanceTime = calculateP99RebalanceTime(rebalanceHistory),
        avgPartitionsMoved = calculateAvgPartitionsMoved(rebalanceHistory),
        avgProcessingPauseTime = calculateAvgPauseTime(rebalanceHistory),
        avgMemberCount = calculateAvgMemberCount(group),
        memberChangeRate = calculateMemberChangeRate(group)
    )
}

/**
 * 优化建议生成
 * /
def generateOptimizationRecommendations(
    metrics: RebalanceOptimizationMetrics
): List[String] = {
    val recommendations = mutable.ListBuffer[String]()

    // 1. 频率问题
    if (metrics.rebounceRate > 1.0) {
        recommendations += "Rebalance 频率过高 (>1 次/分钟)，建议:"
        recommendations += "  1. 检查 session.timeout 配置"
        recommendations += "  2. 使用静态成员"
        recommendations += "  3. 排查网络稳定性"
    }

    // 2. 时间问题
    if (metrics.avgRebalanceTime > 60000) {
        recommendations += "Rebalance 时间过长 (>60s)，建议:"
        recommendations += "  1. 减小组成员数"
        recommendations += "  2. 使用 Cooperative 策略"
        recommendations += "  3. 优化分区分配算法"
    }

    // 3. 影响问题
    if (metrics.avgPartitionsMoved > 50) {
        recommendations += "Rebalance 影响过大，建议:"
        recommendations += "  1. 使用 Sticky 策略"
        recommendations += "  2. 启用 Cooperative 模式"
        recommendations += "  3. 减少不必要的成员变化"
    }

    recommendations.toList
}
```

## 8.9 小结

Rebalance 优化是提升消费性能和稳定性的关键：

1. **静态成员**：减少因成员重启导致的 Rebalance
2. **超时配置**：合理设置各种超时参数
3. **分配策略**：选择合适的分区分配算法
4. **处理优化**：控制处理时间，避免超时
5. **Cooperative 模式**：渐进式重分配，最小化影响
6. **监控诊断**：持续监控和优化

通过综合运用这些策略，可以显著提升消费者组的性能和稳定性。

## 参考文档

- [04-rebalance-process.md](./04-rebalance-process.md) - 重平衡流程
- [03-rebalance-protocol.md](./03-rebalance-protocol.md) - Rebalance 协议
- [10-coordinator-troubleshooting.md](./10-coordinator-troubleshooting.md) - 故障排查
