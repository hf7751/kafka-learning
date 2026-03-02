# 07. 运维操作

## 7.1 日常运维

### 查看 Group 状态

```bash
# 1. 列出所有 Consumer Group
kafka-consumer-groups --bootstrap-server localhost:9092 --list

# 2. 查看特定 Group 详情
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -describe

# 输出示例:
# GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# test-group      test-topic      0          12345           12890           545
# test-group      test-topic      1          6789            7234            445

# 3. 查看所有 Group 的详细状态
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups

# 4. 按 State 过滤
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups \
  - -state Stable
```

### Offset 管理

```bash
# 1. 获取当前 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -describe

# 2. 重置 Offset 到最早
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -reset-offsets \
  - -to-earliest \
  - -execute

# 3. 重置 Offset 到最新
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -reset-offsets \
  - -to-latest \
  - -execute

# 4. 重置 Offset 到指定时间
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -reset-offsets \
  - -to-datetime 2024-03-01T00:00:00.000 \
  - -execute

# 5. 重置 Offset 到指定 Offset 值
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -reset-offsets \
  - -to-offset 1000 \
  - -execute

# 6. 重置 Offset 按时间范围（从现在向前推算）
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -topic test-topic \
  - -reset-offsets \
  - -by-duration PT1H \
  - -execute

# 7. 导出 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -export \
  - -offsets-file offsets.json

# 8. 导入 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -import \
  - -offsets-file offsets.json
```

### 删除 Group

```bash
# 1. 删除 Group（仅当 Group 为空时）
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -delete

# 2. 强制删除 Group（删除 Offset）
# 注意：需要设置 delete.enable.offset.delete=true
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -delete \
  - -force

# 3. 批量删除多个 Group
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group group1 \
  - -group group2 \
  - -group group3 \
  - -delete
```

## 7.2 Rebalance 操作

### 触发 Rebalance

```scala
/**
 * 触发 Rebalance 的方法
 * /

// 方法 1: 停止并重启消费者
// 这是最简单的方法

// 方法 2: 使用 AdminClient 触发
import org.apache.kafka.clients.admin.AdminClient
import org.apache.kafka.clients.admin.ConsumerGroupListing

val adminClient = AdminClient.create(properties)

// 查找 Group
val groups = adminClient.listConsumerGroups().all().get()

// 触发 Rebalance（通过修改订阅）
// 注意：这需要消费者端的支持

// 方法 3: 通过 JMX 操作
// 在某些版本中，可以通过 JMX 触发 Rebalance
```

### Rebalance 期间的操作

```scala
/**
 * Rebalance 期间的最佳实践
 * /

// 1. 监控 Rebalance 状态
def monitorRebalance(groupId: String): Unit = {
    while (true) {
        val group = getGroup(groupId)
        val state = group.currentState

        state match {
            case PreparingRebalance =>
                logger.info(s"Group $groupId is preparing for rebalance")

            case CompletingRebalance =>
                logger.info(s"Group $groupId is completing rebalance")

            case Stable =>
                logger.info(s"Group $groupId is now stable")
                return

            case _ =>
                logger.info(s"Group $groupId is in state $state")
        }

        Thread.sleep(1000)
    }
}

// 2. Rebalance 期间的处理
// Consumer 端需要在回调中处理

consumer.subscribe(
    Collections.singletonList("test-topic"),
    new ConsumerRebalanceListener {
        override def onPartitionsRevoked(
            partitions: Collection[TopicPartition]
        ): Unit = {
            logger.info(s"Partitions revoked: $partitions")

            // 提交当前 Offset
            consumer.commitSync()

            // 完成待处理的任务
            waitForPendingWork()
        }

        override def onPartitionsAssigned(
            partitions: Collection[TopicPartition]
        ): Unit = {
            logger.info(s"Partitions assigned: $partitions")

            // 初始化新分配的分区
            initializePartitions(partitions)
        }
    }
)
```

## 7.3 Coordinator 迁移

### 迁移场景

```scala
/**
 * Coordinator 迁移场景
 *
 * 1. Broker 下线维护
 * 2. 负载均衡
 * 3. 集群扩缩容
 * /

/**
 * 迁移原理:
 *
 * 1. Group 到 Coordinator 的映射关系
 *    - 基于 groupId.hashCode
 *    - 映射到 __consumer_offsets 的分区
 *    - 该分区的 Leader 即为 Coordinator
 *
 * 2. 迁移过程
 *    - 停止 Broker
 *    - Controller 选举新的 Leader
 *    - 新 Leader 成为 Coordinator
 *    - 消费者自动发现新 Coordinator
 * /
```

### 迁移步骤

```bash
# 1. 查看当前 Coordinator 分布
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups | awk '{print $NF}' | sort | uniq -c

# 2. 找到目标 Coordinator 上的 Groups
# 假设 Broker 2 要下线

# 3. 触发分区迁移（迁移 __consumer_offsets）
# 创建迁移计划
cat > reassign.json <<EOF
{
  "version": 1,
  "partitions": [
    {
      "topic": "__consumer_offsets",
      "partition": 0,
      "replicas": [1, 2, 3]
    }
  ]
}
EOF

# 4. 执行迁移
kafka-reassign-partitions --bootstrap-server localhost:9092 \
  - -reassignment-json-file reassign.json \
  - -execute

# 5. 验证迁移
kafka-reassign-partitions --bootstrap-server localhost:9092 \
  - -reassignment-json-file reassign.json \
  - -verify

# 6. 等待 Group 自然迁移
# 消费者会在下次心跳时发现新 Coordinator
# 或者等待 Rebalance 发生

# 7. 强制触发 Rebalance（可选）
# 停止并重启消费者组中的部分成员
```

### 验证迁移结果

```bash
# 1. 检查所有 Groups 是否正常
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups

# 2. 检查 Coordinator 分布
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups | awk '{print $NF}' | sort | uniq -c

# 3. 检查 __consumer_offsets 分区状态
kafka-topics --bootstrap-server localhost:9092 \
  - -topic __consumer_offsets \
  - -describe

# 4. 监控 Rebalance 情况
# 查看日志中是否有频繁的 Rebalance
grep "Preparing for rebalance" /var/log/kafka/server.log
```

## 7.4 容量规划

### 确定组规模

```scala
/**
 * 容量规划计算
 * /
object CapacityPlanning {
    /**
     * 计算需要的 __consumer_offsets 分区数
     *
     * 公式: partitions = ceil(group_count / target_groups_per_partition)
     *
     * 参数:
     * - groupCount: 预期的组数量
     * - targetGroupsPerPartition: 每个分区承载的组数（建议 100）
     * /
    def calculateOffsetPartitions(
        groupCount: Int,
        targetGroupsPerPartition: Int = 100
    ): Int = {
        val partitions = Math.ceil(groupCount.toDouble / targetGroupsPerPartition).toInt

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

    /**
     * 示例:
     * - 1000 个组 -> 16 个分区 (2^4)
     * - 10000 个组 -> 128 个分区 (2^7)
     * - 100000 个组 -> 1024 个分区 (2^10)
     * /

    /**
     * 计算单 Broker 可承载的最大组数
     *
     * 考虑因素:
     * - 内存使用
     * - CPU 使用
     * - 网络带宽
     * - 磁盘 I/O
     * /
    def maxGroupsPerBroker(
        brokerMemoryGB: Int,
        avgMemoryPerGroupMB: Int = 1,
        memoryUtilization: Double = 0.7
    ): Int = {
        val availableMemoryMB = brokerMemoryGB * 1024 * memoryUtilization
        (availableMemoryMB / avgMemoryPerGroupMB).toInt
    }

    /**
     * 示例:
     * - Broker: 32GB 内存
     * - 每组平均: 1MB
     * - 利用率: 70%
     * - 最大组数: 32 * 1024 * 0.7 / 1 = 22,755 组
     * /
}
```

### 扩容操作

```bash
# 1. 增加 __consumer_offsets 分区数
kafka-topics --bootstrap-server localhost:9092 \
  - -topic __consumer_offsets \
  - -alter \
  - -partitions 100

# 注意:
# - 只能增加分区，不能减少
# - 现有组不会自动迁移到新分区
# - 新组会分布到所有分区

# 2. 监控分区分布
# 使用 JMX 或工具查看各分区的组数量

# 3. 如需重新平衡，可以:
# a) 等待新组的加入
# b) 删除并重建组（会丢失 Offset）
# c) 手动迁移 Offset
```

## 7.5 故障恢复

### Coordinator 故障

```scala
/**
 * Coordinator 故障恢复流程
 * /

/**
 * 故障检测
 * /
// 1. 消费者端检测
// 消费者会收到 NotCoordinatorForGroupError
// 需要重新查找 Coordinator

// 2. Broker 端检测
// Controller 检测到 Broker 故障
// 触发 Leader 选举

/**
 * 自动恢复流程
 * /
// 1. 新 Leader 被选举
// 2. 新 Leader 成为 Coordinator
// 3. 从 __consumer_offsets 加载 Group 元数据
// 4. 消费者重新连接到新 Coordinator
// 5. 可能触发 Rebalance

/**
 * 加速恢复
 * /
// 1. 减少 session.timeout.ms
// 让故障更快被检测

// 2. 使用更短的 heartbeat.interval.ms
// 更快发现新 Coordinator

// 3. 增加请求超时
// 避免恢复期间的误报
```

### 数据恢复

```bash
# 1. 检查 __consumer_offsets Topic
kafka-topics --bootstrap-server localhost:9092 \
  - -topic __consumer_offsets \
  - -describe

# 2. 检查分区状态
kafka-topics --bootstrap-server localhost:9092 \
  - -topic __consumer_offsets \
  - -describe \
  - -under-replicated-partitions

# 3. 修复离线分区
kafka-reassign-partitions --bootstrap-server localhost:9092 \
  - -reassignment-json-file fix-offline.json \
  - -execute

# 4. 验证数据完整性
# 消费 __consumer_offsets 并验证内容
kafka-console-consumer --bootstrap-server localhost:9092 \
  - -topic __consumer_offsets \
  - -from-beginning \
  - -formatter "kafka.tools.DefaultMessageFormatter" \
  - -property print.key=true \
  - -property print.value=true \
  - -property key.separator="," \
  - -max-messages 100
```

## 7.6 性能调优

### Broker 端调优

```bash
# 1. 调整 __consumer_offsets 配置
# 增加副本数（提高可靠性）
kafka-configs --bootstrap-server localhost:9092 \
  - -entity-type topics \
  - -entity-name __consumer_offsets \
  - -alter \
  - -add-config min.insync.replicas=2

# 调整段大小（减少磁盘使用）
kafka-configs --bootstrap-server localhost:9092 \
  - -entity-type topics \
  - -entity-name __consumer_offsets \
  - -alter \
  - -add-config segment.bytes=52428800

# 2. 调整 Coordinator 配置
# 在 server.properties 中设置
# 增加处理线程
group.coordinator.threads=8

# 增加心跳线程池大小
group.coordinator.heartbeat.threads=4

# 调整初始 Rebalance 延迟
group.initial.rebalance.delay.ms=3000
```

### Consumer 端调优

```bash
# 1. 调整 Fetch 参数
# 增加 fetch 大小
fetch.max.bytes=52428800
max.partition.fetch.bytes=1048576

# 调整等待时间
fetch.max.wait.ms=500
fetch.min.bytes=102400

# 2. 调整会话参数
# 根据网络环境调整
session.timeout.ms=30000
heartbeat.interval.ms=10000
max.poll.interval.ms=300000

# 3. 调整批量大小
max.poll.records=1000
```

## 7.7 监控与告警

### 关键指标监控

```bash
# 1. 使用 JMX 监控
jconsole
jvisualvm
# 或使用 Prometheus JMX Exporter

# 2. 关键指标
# - kafka.coordinator.group:type=GroupCoordinator
#   * NumGroups
#   * NumGroupsPreparingRebalance
#   * NumGroupsCompletingRebalance
#   * RebalanceRate
#   * RebalanceTimeAvg

# - kafka.network:type=RequestMetrics,name=*
#   * RequestRate (for JoinGroup, SyncGroup, Heartbeat, etc.)
#   * RequestLatencyAvg

# 3. 设置告警
# 当 Rebalance 速率 > 0.1 次/秒时告警
# 当 Rebalance 时间 > 60 秒时告警
# 当 Offset 提交失败率 > 5% 时告警
```

### 日志分析

```bash
# 1. 查看 Rebalance 日志
grep "rebalance" /var/log/kafka/server.log | tail -100

# 2. 查看 Coordinator 错误
grep "GroupCoordinator" /var/log/kafka/server.log | grep ERROR

# 3. 统计 Rebalance 频率
grep "Preparing for rebalance" /var/log/kafka/server.log | \
  awk '{print $1, $2}' | uniq -c

# 4. 分析 Group 生命周期
grep "Group .* transitioned" /var/log/kafka/server.log
```

## 7.8 常见运维场景

### 场景 1: 升级 Kafka 版本

```bash
# 1. 滚动升级
# 一次升级一个 Broker

# 2. 升级前检查
# 检查 __consumer_offsets 兼容性
kafka-run-class kafka.tools.OffsetChecker \
  - -broker-list localhost:9092 \
  - -group test-group \
  - -zookeeper localhost:2181

# 3. 升级 Broker
# 停止 Broker
# 升级软件
# 启动 Broker

# 4. 验证
# 检查 Group 是否正常
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group test-group \
  - -describe

# 5. 监控 Rebalance
# 观察是否有异常的 Rebalance
```

### 场景 2: 迁移到新集群

```bash
# 1. 在新集群创建 Topic
kafka-topics --bootstrap-server new-cluster:9092 \
  - -topic test-topic \
  - -create \
  - -partitions 10 \
  - -replication-factor 3

# 2. 迁移数据
kafka-mirror-maker --consumer.config old-cluster.consumer.properties \
  - -producer.config new-cluster.producer.properties \
  - -whitelist test-topic

# 3. 迁移 Offset
# 导出旧集群 Offset
kafka-consumer-groups --bootstrap-server old-cluster:9092 \
  - -group test-group \
  - -export \
  - -offsets-file offsets.json

# 转换并导入到新集群
# 需要手动处理 Offset 映射

# 4. 切换消费者
# 更新 bootstrap.servers 配置
# 重启消费者

# 5. 验证
# 检查消费是否正常
```

### 场景 3: 处理僵尸组

```bash
# 1. 识别僵尸组
# 组状态为 Stable 但没有活跃成员
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -describe \
  - -all-groups | awk '{if ($NF == "Stable") print $0}'

# 2. 检查成员是否真的活跃
# 查看日志或监控

# 3. 处理僵尸组
# 选项 1: 等待 session.timeout 超时
# 选项 2: 删除组
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group zombie-group \
  - -delete

# 选项 3: 重置 Offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  - -group zombie-group \
  - -reset-offsets \
  - -to-latest \
  - -execute
```

## 7.9 小结

日常运维是保障 GroupCoordinator 稳定运行的关键：

1. **监控状态**：定期检查 Group 和 Coordinator 状态
2. **Offset 管理**：熟练掌握 Offset 查看和重置操作
3. **Rebalance 处理**：理解和监控 重平衡过程
4. **容量规划**：根据组数量合理规划集群容量
5. **故障恢复**：掌握常见故障的处理方法
6. **性能调优**：持续优化 Broker 和 Consumer 配置

## 参考文档

- [08-rebalance-optimization.md](./08-rebalance-optimization.md) - Rebalance 优化
- [10-coordinator-troubleshooting.md](./10-coordinator-troubleshooting.md) - 故障排查
- [09-coordinator-monitoring.md](./09-coordinator-monitoring.md) - 监控指标
