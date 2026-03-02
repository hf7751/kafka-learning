# 09. 监控指标

## 9.1 监控概述

### 监控目标

```scala
/**
 * GroupCoordinator 监控目标:
 *
 * 1. 可用性监控
 *    - Coordinator 是否在线
 *    - 服务是否正常
 *
 * 2. 性能监控
 *    - 请求处理延迟
 *    - 吞吐量
 *    - 资源使用
 *
 * 3. 稳定性监控
 *    - Rebalance 频率
 *    - 错误率
 *    - 异常情况
 *
 * 4. 业务监控
 *    - 消费进度
 *    - Lag 情况
 *    - 处理能力
 * /
```

## 9.2 Broker 端指标

### Coordinator 指标

```scala
/**
 * Broker 端 GroupCoordinator 指标
 *
 * MBean: kafka.coordinator.group:type=GroupCoordinator
 * /
object CoordinatorMetrics {
    // 组管理指标
    val NumGroups = "NumGroups"                       // 当前组数量
    val NumGroupsPreparingRebalance = "NumGroupsPreparingRebalance"
    val NumGroupsCompletingRebalance = "NumGroupsCompletingRebalance"
    val NumGroupsStable = "NumGroupsStable"
    val NumGroupsDead = "NumGroupsDead"
    val NumGroupsEmpty = "NumGroupsEmpty"

    // 成员指标
    val NumMembers = "NumMembers"                     // 总成员数
    val AvgMembersPerGroup = "AvgMembersPerGroup"

    // Rebalance 指标
    val RebalanceRate = "RebalanceRate"               // Rebalance 速率 (次/秒)
    val RebalanceRatePerGroup = "RebalanceRatePerGroup"
    val RebalanceTimeAvg = "RebalanceTimeAvg"         // 平均 Rebalance 时间
    val RebalanceTimeMax = "RebalanceTimeMax"
    val RebalanceTimeTotal = "RebalanceTimeTotal"

    // Offset 指标
    val OffsetCommitRate = "OffsetCommitRate"         // Offset 提交速率
    val OffsetCommitAvgTimeMs = "OffsetCommitAvgTimeMs"
    val OffsetCommitFailedRate = "OffsetCommitFailedRate"

    // 请求指标
    val RequestRate = "RequestRate"                   // 请求速率
    val RequestQueueSize = "RequestQueueSize"         // 请求队列大小
    val RequestLatencyAvg = "RequestLatencyAvg"       // 请求平均延迟
}

/**
 * 指标采集示例
 * /
class CoordinatorMetricsReporter(coordinator: GroupCoordinator) {
    def collectMetrics(): CoordinatorMetricsSnapshot = {
        val metricsSystem = coordinator.metrics

        CoordinatorMetricsSnapshot(
            timestamp = System.currentTimeMillis(),
            numGroups = getMetric(metricsSystem, CoordinatorMetrics.NumGroups),
            numMembers = getMetric(metricsSystem, CoordinatorMetrics.NumMembers),
            rebalanceRate = getMetric(metricsSystem, CoordinatorMetrics.RebalanceRate),
            rebalanceTimeAvg = getMetric(metricsSystem, CoordinatorMetrics.RebalanceTimeAvg),
            offsetCommitRate = getMetric(metricsSystem, CoordinatorMetrics.OffsetCommitRate),
            requestLatencyAvg = getMetric(metricsSystem, CoordinatorMetrics.RequestLatencyAvg)
        )
    }

    private def getMetric(metrics: Metrics, name: String): Double = {
        metrics.metrics().get(metrics.metricName(name, "group-coordinator")) match {
            case null => 0.0
            case metric => metric.metricValue().asInstanceOf[Double]
        }
    }
}
```

### Request 指标

```scala
/**
 * Request 相关指标
 *
 * MBean: kafka.network:type=RequestMetrics,name=*
 * /
object RequestMetrics {
    // JoinGroup 请求
    val JoinGroupRequestRate = "RequestRate,name=JoinGroup"
    val JoinGroupRequestLatencyAvg = "RequestLatencyAvgMs,name=JoinGroup"
    val JoinGroupRequestLatencyMax = "RequestLatencyMaxMs,name=JoinGroup"
    val JoinGroupRequestQueueTimeAvg = "RequestQueueTimeAvgMs,name=JoinGroup"
    val JoinGroupRequestLocalTimeAvg = "RequestLocalTimeAvgMs,name=JoinGroup"
    val JoinGroupRequestTotalTimeAvg = "RequestTotalTimeAvgMs,name=JoinGroup"

    // SyncGroup 请求
    val SyncGroupRequestRate = "RequestRate,name=SyncGroup"
    val SyncGroupRequestLatencyAvg = "RequestLatencyAvgMs,name=SyncGroup"
    val SyncGroupRequestLatencyMax = "RequestLatencyMaxMs,name=SyncGroup"

    // Heartbeat 请求
    val HeartbeatRequestRate = "RequestRate,name=Heartbeat"
    val HeartbeatRequestLatencyAvg = "RequestLatencyAvgMs,name=Heartbeat"
    val HeartbeatRequestLatencyMax = "RequestLatencyMaxMs,name=Heartbeat"

    // OffsetCommit 请求
    val OffsetCommitRequestRate = "RequestRate,name=OffsetCommit"
    val OffsetCommitRequestLatencyAvg = "RequestLatencyAvgMs,name=OffsetCommit"
    val OffsetCommitRequestLatencyMax = "RequestLatencyMaxMs,name=OffsetCommit"

    // OffsetFetch 请求
    val OffsetFetchRequestRate = "RequestRate,name=OffsetFetch"
    val OffsetFetchRequestLatencyAvg = "RequestLatencyAvgMs,name=OffsetFetch"
}
```

## 9.3 Consumer 端指标

### 消费者指标

```scala
/**
 * Consumer 端指标
 *
 * MBean: kafka.consumer:type=consumer-metrics,client-id=*
 * /
object ConsumerMetrics {
    // 连接指标
    val ConnectionCount = "connection-count"           // 连接数
    val ConnectionCreationRate = "connection-creation-rate"
    val ConnectionCloseRate = "connection-close-rate"

    // 网络指标
    val NetworkIORate = "network-io-rate"             // 网络速率 (字节/秒)
    val IncomingByteRate = "incoming-byte-rate"       // 接收速率
    val OutgoingByteRate = "outgoing-byte-rate"       // 发送速率
    val RequestRate = "request-rate"                  // 请求速率
    val RequestLatencyAvg = "request-latency-avg"     // 请求平均延迟
    val RequestLatencyMax = "request-latency-max"     // 请求最大延迟

    // Fetch 指标
    val FetchRate = "fetch-rate"                      // Fetch 速率
    val FetchLatencyAvg = "fetch-latency-avg"         // Fetch 平均延迟
    val FetchLatencyMax = "fetch-latency-max"
    val FetchSizeAvg = "fetch-size-avg"               // 平均 Fetch 大小
    val FetchSizeMax = "fetch-size-max"
    val RecordsPerRequestAvg = "records-per-request-avg"

    // 消费指标
    val RecordsConsumedRate = "records-consumed-rate" // 消费速率
    val RecordsConsumedTotal = "records-consumed-total"
    val BytesConsumedRate = "bytes-consumed-rate"
    val BytesConsumedTotal = "bytes-consumed-total"

    // 消费延迟指标
    val RecordsLagMax = "records-lag-max"             // 最大 Lag
    val RecordsLagAvg = "records-lag-avg"             // 平均 Lag
    val RecordsLag = "records-lag"                    // 当前 Lag (按分区)

    // Offset 指标
    val CommitRate = "commit-rate"                    // 提交速率
    val CommitLatencyAvg = "commit-latency-avg"
    val CommitLatencyMax = "commit-latency-max"
    val CommitTotal = "commit-total"
    val CommitFailed = "commit-failed"                // 提交失败次数

    // Rebalance 指标
    val RebalanceLatencyAvg = "rebalance-latency-avg" // Rebalance 延迟
    val RebalanceLatencyMax = "rebalance-latency-max"
    val RebalanceTotal = "rebalance-total"            // Rebalance 总次数
    val LastRebalanceSecondsAgo = "last-rebalance-seconds-ago"
    val FailedRebalanceTotal = "failed-rebalance-total"

    // 心跳指标
    val HeartbeatRate = "heartbeat-rate"              // 心跳速率
    val HeartbeatResponseTimeMax = "heartbeat-response-time-max"
    val HeartbeatTotal = "heartbeat-total"
}

/**
 * 指标采集示例
 * /
class ConsumerMetricsReporter(consumer: KafkaConsumer[_, _]) {
    def collectMetrics(): ConsumerMetricsSnapshot = {
        val metrics = consumer.metrics()

        ConsumerMetricsSnapshot(
            timestamp = System.currentTimeMillis(),
            connectionCount = getMetric(metrics, ConsumerMetrics.ConnectionCount),
            incomingByteRate = getMetric(metrics, ConsumerMetrics.IncomingByteRate),
            outgoingByteRate = getMetric(metrics, ConsumerMetrics.OutgoingByteRate),
            fetchRate = getMetric(metrics, ConsumerMetrics.FetchRate),
            fetchLatencyAvg = getMetric(metrics, ConsumerMetrics.FetchLatencyAvg),
            recordsConsumedRate = getMetric(metrics, ConsumerMetrics.RecordsConsumedRate),
            recordsLagMax = getMetric(metrics, ConsumerMetrics.RecordsLagMax),
            commitRate = getMetric(metrics, ConsumerMetrics.CommitRate),
            heartbeatRate = getMetric(metrics, ConsumerMetrics.HeartbeatRate),
            rebalanceTotal = getMetric(metrics, ConsumerMetrics.RebalanceTotal),
            lastRebalanceSecondsAgo = getMetric(metrics, ConsumerMetrics.LastRebalanceSecondsAgo)
        )
    }

    private def getMetric(metrics: Metrics, name: String): Double = {
        metrics.metrics().asScala
            .find(_.name().name() == name)
            .map(_.metricValue().asInstanceOf[Double])
            .getOrElse(0.0)
    }
}
```

## 9.4 组级别指标

### 组详情指标

```scala
/**
 * 组级别监控指标
 * /
case class GroupMetrics(
    // 基本信息指标
    groupId: String,
    state: String,
    generationId: Int,

    // 成员指标
    memberCount: Int,
    members: List[MemberMetrics],

    // 分区指标
    assignedPartitions: Int,
    partitionsPerMember: Map[String, Set[TopicPartition]],

    // 进度指标
    totalLag: Long,
    partitionLag: Map[TopicPartition, Long],

    // Rebalance 指标
    rebalanceCount: Long,
    lastRebalanceTime: Long,
    avgRebalanceDuration: Long,

    // 时间戳
    timestamp: Long
)

case class MemberMetrics(
    memberId: String,
    clientId: String,
    clientHost: String,
    assignment: Set[TopicPartition],
    lag: Map[TopicPartition, Long],
    lastHeartbeat: Long
)

/**
 * 收集组指标
 * /
def collectGroupMetrics(groupId: String): GroupMetrics = {
    val group = getGroup(groupId)

    // 1. 基本信息
    val state = group.currentState.name
    val generationId = group.generationId

    // 2. 成员信息
    val members = group.members.values.map { member =>
        MemberMetrics(
            memberId = member.memberId,
            clientId = member.clientId,
            clientHost = member.clientHost,
            assignment = deserializeAssignment(member.assignment),
            lag = getMemberLag(member),
            lastHeartbeat = member.lastHeartbeatTimestamp
        )
    }.toList

    // 3. 分区分配
    val assignedPartitions = members.flatMap(_.assignment).toSet.size
    val partitionsPerMember = members.map(m => m.memberId -> m.assignment).toMap

    // 4. Lag 信息
    val partitionLag = collectPartitionLag(groupId)
    val totalLag = partitionLag.values.sum

    // 5. Rebalance 统计
    val rebalanceHistory = group.rebalanceHistory
    val rebalanceCount = rebalanceHistory.size
    val lastRebalanceTime = rebalanceHistory.lastOption.map(_.timestamp).getOrElse(0L)
    val avgRebalanceDuration = if (rebalanceHistory.nonEmpty) {
        rebalanceHistory.map(_.duration).sum / rebalanceHistory.size
    } else {
        0L
    }

    GroupMetrics(
        groupId = groupId,
        state = state,
        generationId = generationId,
        memberCount = members.size,
        members = members,
        assignedPartitions = assignedPartitions,
        partitionsPerMember = partitionsPerMember,
        totalLag = totalLag,
        partitionLag = partitionLag,
        rebalanceCount = rebalanceCount,
        lastRebalanceTime = lastRebalanceTime,
        avgRebalanceDuration = avgRebalanceDuration,
        timestamp = System.currentTimeMillis()
    )
}
```

### Lag 监控

```scala
/**
 * Lag 监控
 *
 * Lag = Latest Offset - Committed Offset
 * /
object LagMonitor {
    /**
     * 获取分区 Lag
     * /
    def getPartitionLag(
        groupId: String,
        topicPartition: TopicPartition
    ): Long = {
        val committedOffset = getCommittedOffset(groupId, topicPartition)
        val latestOffset = getLatestOffset(topicPartition)

        latestOffset - committedOffset.offset()
    }

    /**
     * 获取组总 Lag
     * /
    def getGroupLag(groupId: String): Long = {
        val group = getGroup(groupId)
        val partitions = getAllAssignedPartitions(group)

        partitions.map { tp =>
            getPartitionLag(groupId, tp)
        }.sum
    }

    /**
     * Lag 告警
     * /
    def checkLagAlert(
        groupId: String,
        thresholds: LagThresholds
    ): LagAlert = {
        val lagByPartition = collectPartitionLag(groupId)

        val highLagPartitions = lagByPartition.filter { case (tp, lag) =>
            lag > thresholds.highThreshold
        }

        val mediumLagPartitions = lagByPartition.filter { case (tp, lag) =>
            lag > thresholds.mediumThreshold && lag <= thresholds.highThreshold
        }

        val totalLag = lagByPartition.values.sum

        LagAlert(
            groupId = groupId,
            totalLag = totalLag,
            highLagPartitions = highLagPartitions,
            mediumLagPartitions = mediumLagPartitions,
            alertLevel = determineAlertLevel(totalLag, thresholds)
        )
    }

    private def determineAlertLevel(
        totalLag: Long,
        thresholds: LagThresholds
    ): AlertLevel = {
        if (totalLag > thresholds.criticalThreshold) {
            AlertLevel.CRITICAL
        } else if (totalLag > thresholds.highThreshold) {
            AlertLevel.HIGH
        } else if (totalLag > thresholds.mediumThreshold) {
            AlertLevel.MEDIUM
        } else {
            AlertLevel.NORMAL
        }
    }
}

case class LagThresholds(
    mediumThreshold: Long = 10000,
    highThreshold: Long = 100000,
    criticalThreshold: Long = 1000000
)

sealed trait AlertLevel
case object NORMAL extends AlertLevel
case object MEDIUM extends AlertLevel
case object HIGH extends AlertLevel
case object CRITICAL extends AlertLevel

case class LagAlert(
    groupId: String,
    totalLag: Long,
    highLagPartitions: Map[TopicPartition, Long],
    mediumLagPartitions: Map[TopicPartition, Long],
    alertLevel: AlertLevel
)
```

## 9.5 告警规则

### Prometheus 告警规则

```yaml
# Kafka Coordinator 告警规则

groups:
  - name: kafka_coordinator
    interval: 30s
    rules:
      # Rebalance 频率过高
      - alert: HighRebalanceRate
        expr: rate(kafka_coordinator_group_RebalanceRate[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Consumer group rebalance rate too high"
          description: "Rebalance rate is {{ $value }} rebalances/sec"

      # Rebalance 时间过长
      - alert: LongRebalanceTime
        expr: kafka_coordinator_group_RebalanceTimeAvg > 60000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Rebalance taking too long"
          description: "Average rebalance time is {{ $value }}ms"

      # Consumer Lag 过高
      - alert: HighConsumerLag
        expr: kafka_consumer_consumer_lag > 100000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Consumer lag too high"
          description: "Consumer lag is {{ $value }} messages"

      # Offset 提交失败率过高
      - alert: HighOffsetCommitFailureRate
        expr: rate(kafka_coordinator_group_OffsetCommitFailedRate[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Offset commit failure rate too high"
          description: "Offset commit failure rate is {{ $value }} commits/sec"

      # 心跳失败率过高
      - alert: HighHeartbeatFailureRate
        expr: rate(kafka_consumer_heartbeat_failure_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Heartbeat failure rate too high"
          description: "Heartbeat failure rate is {{ $value }} failures/sec"
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Kafka Coordinator Monitoring",
    "panels": [
      {
        "title": "Rebalance Rate",
        "targets": [
          {
            "expr": "rate(kafka_coordinator_group_RebalanceRate[1m])"
          }
        ]
      },
      {
        "title": "Rebalance Time",
        "targets": [
          {
            "expr": "kafka_coordinator_group_RebalanceTimeAvg"
          }
        ]
      },
      {
        "title": "Consumer Lag",
        "targets": [
          {
            "expr": "kafka_consumer_consumer_lag"
          }
        ]
      },
      {
        "title": "Offset Commit Rate",
        "targets": [
          {
            "expr": "rate(kafka_coordinator_group_OffsetCommitRate[1m])"
          }
        ]
      },
      {
        "title": "Request Latency",
        "targets": [
          {
            "expr": "kafka_consumer_request_latency_avg"
          }
        ]
      }
    ]
  }
}
```

## 9.6 监控最佳实践

### 指标采集频率

```scala
/**
 * 指标采集频率建议
 * /
object MetricsCollectionFrequency {
    // 高频指标 (10 秒)
    val highFrequencyMetrics = Set(
        "RebalanceRate",
        "RequestRate",
        "FetchRate",
        "HeartbeatRate"
    )

    // 中频指标 (30 秒)
    val mediumFrequencyMetrics = Set(
        "RebalanceTimeAvg",
        "RequestLatencyAvg",
        "RecordsLagMax",
        "CommitRate"
    )

    // 低频指标 (1 分钟)
    val lowFrequencyMetrics = Set(
        "NumGroups",
        "NumMembers",
        "AvgMembersPerGroup"
    )

    /**
     * 获取采集频率
     * /
    def getCollectionFrequency(metricName: String): Int = {
        if (highFrequencyMetrics.contains(metricName)) {
            10  // 10 秒
        } else if (mediumFrequencyMetrics.contains(metricName)) {
            30  // 30 秒
        } else {
            60  // 1 分钟
        }
    }
}
```

### 指标聚合与展示

```scala
/**
 * 指标聚合策略
 * /
class MetricsAggregator {
    /**
     * 按组聚合
     * /
    def aggregateByGroup(
        metrics: Seq[GroupMetrics]
    ): Map[String, GroupAggregatedMetrics] = {
        metrics.groupBy(_.groupId).map { case (groupId, groupMetrics) =>
            groupId -> GroupAggregatedMetrics(
                totalLag = groupMetrics.map(_.totalLag).sum,
                avgLag = groupMetrics.map(_.totalLag).sum / groupMetrics.size,
                maxLag = groupMetrics.map(_.totalLag).max,
                totalRebalances = groupMetrics.map(_.rebalanceCount).sum,
                avgRebalanceDuration = groupMetrics.map(_.avgRebalanceDuration).sum / groupMetrics.size,
                memberCount = groupMetrics.head.memberCount
            )
        }
    }

    /**
     * 按时间聚合
     * /
    def aggregateByTime(
        metrics: Seq[GroupMetrics],
        windowSizeMs: Long
    ): Seq[TimeWindowMetrics] = {
        val windows = metrics.groupBy { metric =>
            metric.timestamp / windowSizeMs
        }.toSeq.sortBy(_._1)

        windows.map { case (windowId, windowMetrics) =>
            TimeWindowMetrics(
                windowStart = windowId * windowSizeMs,
                windowEnd = (windowId + 1) * windowSizeMs,
                totalGroups = windowMetrics.size,
                totalMembers = windowMetrics.map(_.memberCount).sum,
                avgLag = windowMetrics.map(_.totalLag).sum / windowMetrics.size,
                rebalanceCount = windowMetrics.map(_.rebalanceCount).sum
            )
        }
    }
}
```

### 监控报告

```scala
/**
 * 生成监控报告
 * /
class MonitoringReportGenerator {
    def generateReport(
        groupMetrics: Seq[GroupMetrics],
        coordinatorMetrics: CoordinatorMetricsSnapshot
    ): MonitoringReport = {
        // 1. 总体概况
        val overview = generateOverview(groupMetrics, coordinatorMetrics)

        // 2. 问题分析
        val issues = analyzeIssues(groupMetrics, coordinatorMetrics)

        // 3. 建议
        val recommendations = generateRecommendations(issues)

        MonitoringReport(
            timestamp = System.currentTimeMillis(),
            overview = overview,
            issues = issues,
            recommendations = recommendations
        )
    }

    private def generateOverview(
        groupMetrics: Seq[GroupMetrics],
        coordinatorMetrics: CoordinatorMetricsSnapshot
    ): OverviewSection = {
        OverviewSection(
            totalGroups = coordinatorMetrics.numGroups,
            totalMembers = coordinatorMetrics.numMembers,
            avgMembersPerGroup = coordinatorMetrics.numMembers / coordinatorMetrics.numGroups,
            rebalanceRate = coordinatorMetrics.rebalanceRate,
            avgRebalanceTime = coordinatorMetrics.rebalanceTimeAvg,
            totalLag = groupMetrics.map(_.totalLag).sum,
            highLagGroups = groupMetrics.count(_.totalLag > 100000)
        )
    }

    private def analyzeIssues(
        groupMetrics: Seq[GroupMetrics],
        coordinatorMetrics: CoordinatorMetricsSnapshot
    ): List[Issue] = {
        val issues = mutable.ListBuffer[Issue]()

        // 检查高频 Rebalance
        if (coordinatorMetrics.rebalanceRate > 0.1) {
            issues += Issue(
                level = IssueLevel.WARNING,
                category = "Rebalance",
                description = s"Rebalance rate is high: ${coordinatorMetrics.rebalanceRate}",
                affectedGroups = groupMetrics.filter(_.rebalanceCount > 10).map(_.groupId)
            )
        }

        // 检查高 Lag
        groupMetrics.filter(_.totalLag > 100000).foreach { group =>
            issues += Issue(
                level = IssueLevel.CRITICAL,
                category = "Lag",
                description = s"Group ${group.groupId} has high lag: ${group.totalLag}",
                affectedGroups = List(group.groupId)
            )
        }

        issues.toList
    }

    private def generateRecommendations(issues: List[Issue]): List[Recommendation] = {
        val recommendations = mutable.ListBuffer[Recommendation]()

        issues.filter(_.category == "Rebalance").foreach { _ =>
            recommendations += Recommendation(
                category = "Configuration",
                description = "Consider increasing session.timeout.ms or using static members",
                priority = RecommendationPriority.HIGH
            )
        }

        recommendations.toList
    }
}

case class MonitoringReport(
    timestamp: Long,
    overview: OverviewSection,
    issues: List[Issue],
    recommendations: List[Recommendation]
)

case class OverviewSection(
    totalGroups: Double,
    totalMembers: Double,
    avgMembersPerGroup: Double,
    rebalanceRate: Double,
    avgRebalanceTime: Double,
    totalLag: Long,
    highLagGroups: Int
)
```

## 9.7 小结

完善的监控体系是保障 GroupCoordinator 稳定运行的关键：

1. **多维度指标**：Broker 端、Consumer 端、组级别
2. **告警规则**：设置合理的阈值和级别
3. **可视化**：使用 Grafana 等工具展示
4. **报告分析**：定期生成监控报告
5. **持续优化**：根据监控数据不断优化

## 参考文档

- [08-rebalance-optimization.md](./08-rebalance-optimization.md) - Rebalance 优化
- [10-coordinator-troubleshooting.md](./10-coordinator-troubleshooting.md) - 故障排查
- [11-coordinator-config.md](./11-coordinator-config.md) - 配置详解
