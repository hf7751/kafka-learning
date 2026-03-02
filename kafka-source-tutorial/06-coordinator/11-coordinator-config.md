# 11. 配置详解

## 11.1 Broker 配置

### Coordinator 相关配置

```scala
/**
 * Broker 端 Coordinator 配置
 * /

/**
 * 1. offsets.topic.replication.factor
 *
 * 默认: 3
 * 范围: [1, Short.MaxValue]
 * 重要性: 高
 *
 * 说明: __consumer_offsets Topic 的副本因子
 *
 * 影响:
 * - 数据可靠性
 * - 故障恢复能力
 * - 磁盘空间占用
 *
 * 建议:
 * - 生产环境: 3
 * - 测试环境: 1
 * /
offsets.topic.replication.factor=3

/**
 * 2. offsets.topic.num.partitions
 *
 * 默认: 50
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: __consumer_offsets Topic 的分区数
 *
 * 影响:
 * - 并行处理能力
 * - 负载均衡
 * - 组迁移性能
 *
 * 建议:
 * - 小规模 (< 1000 组): 25
 * - 中规模 (1000-10000 组): 50
 * - 大规模 (> 10000 组): 100+
 *
 * 计算公式:
 * partitions = ceil(group_count / 100)
 * /
offsets.topic.num.partitions=50

/**
 * 3. offsets.topic.segment.bytes
 *
 * 默认: 104857600 (100 MB)
 * 范围: [1, Int.MaxValue]
 * 重要性: 低
 *
 * 说明: __consumer_offsets Topic 的段大小
 *
 * 影响:
 * - 磁盘使用
 * - 清理效率
 * - 恢复时间
 *
 * 建议:
 * - 保持默认值
 * - 仅在特殊场景调整
 * /
offsets.topic.segment.bytes=104857600

/**
 * 4. offsets.topic.compression.codec
 *
 * 默认: 0 (none)
 * 范围: [0, 3]
 * 重要性: 低
 *
 * 说明: __consumer_offsets 的压缩算法
 *
 * 可选值:
 * 0 = none
 * 1 = gzip
 * 2 = snappy
 * 3 = lz4
 *
 * 建议: 使用 lz4 (性能好)
 * /
offsets.topic.compression.codec=3

/**
 * 5. offsets.retention.minutes
 *
 * 默认: 10080 (7 天)
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: Offset 的保留时间
 *
 * 影响:
 * - 磁盘空间
 * - 历史追溯能力
 * - 重新消费能力
 *
 * 建议:
 * - 临时数据: 1 天
 * - 普通业务: 7 天
 * - 重要业务: 30 天
 * /
offsets.retention.minutes=10080

/**
 * 6. offsets.retention.check.interval.ms
 *
 * 默认: 600000 (10 分钟)
 * 范围: [1, Long.MaxValue]
 * 重要性: 低
 *
 * 说明: Offset 过期检查间隔
 *
 * 建议: 保持默认值
 * /
offsets.retention.check.interval.ms=600000

/**
 * 7. group.min.session.timeout.ms
 *
 * 默认: 6000 (6 秒)
 * 范围: [1, group.max.session.timeout.ms]
 * 重要性: 高
 *
 * 说明: 最小会话超时时间
 *
 * 影响: 限制消费者的最小 session.timeout
 *
 * 建议:
 * - 根据网络环境调整
 * - 通常保持默认值
 * /
group.min.session.timeout.ms=6000

/**
 * 8. group.max.session.timeout.ms
 *
 * 默认: 300000 (5 分钟)
 * 范围: [group.min.session.timeout.ms, Int.MaxValue]
 * 重要性: 高
 *
 * 说明: 最大会话超时时间
 *
 * 影响: 限制消费者的最大 session.timeout
 *
 * 建议:
 * - 容器环境: 600000 (10 分钟)
 * - 不稳定网络: 可增大
 * /
group.max.session.timeout.ms=300000

/**
 * 9. group.initial.rebalance.delay.ms
 *
 * 默认: 3000 (3 秒)
 * 范围: [0, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 组首次 Rebalance 的等待时间
 *
 * 影响:
 * - 启动速度
 * - 成员聚集
 * - Rebalance 次数
 *
 * 建议:
 * - 快速启动: 0
 * - 集群启动: 3000-5000
 * - 大规模: 10000+
 * /
group.initial.rebalance.delay.ms=3000

/**
 * 10. group.max.rebalance.timeout.ms
 *
 * 默认: 600000 (10 分钟)
 * 范围: [1, Int.MaxValue]
 * 重要性: 高
 *
 * 说明: Rebalance 最大超时时间
 *
 * 影响:
 * - Rebalance 完成时间
 * - 组可用性
 *
 * 建议:
 * - 正常环境: 600000
 * - 大规模组: 可增大到 1200000
 * /
group.max.rebalance.timeout.ms=600000
```

## 11.2 Consumer 配置

### 基础配置

```scala
/**
 * Consumer 基础配置
 * /

/**
 * 1. group.id
 *
 * 默认: null (必填)
 * 重要性: 高
 *
 * 说明: 消费者组 ID
 *
 * 建议:
 * - 使用有意义的名称
 * - 包含应用名和用途
 * - 例如: order-processing-consumer
 * /
props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-consumer-group")

/**
 * 2. bootstrap.servers
 *
 * 默认: null (必填)
 * 重要性: 高
 *
 * 说明: Kafka 集群地址
 *
 * 建议:
 * - 配置多个 Broker
 * - 使用主机名而非 IP
 * - 确保高可用
 * /
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG,
          "broker1:9092,broker2:9092,broker3:9092")

/**
 * 3. client.id
 *
 * 默认: ""
 * 重要性: 中
 *
 * 说明: 客户端标识
 *
 * 建议:
 * - 使用唯一标识
 * - 包含主机名和实例
 * - 例如: consumer-1-host-192-168-1-10
 * /
props.put(ConsumerConfig.CLIENT_ID_CONFIG, "client-1")
```

### 会话与心跳配置

```scala
/**
 * 会话与心跳配置
 * /

/**
 * 4. session.timeout.ms
 *
 * 默认: 45000 (45 秒)
 * 范围: [group.min.session.timeout.ms, group.max.session.timeout.ms]
 * 重要性: 高
 *
 * 说明: 会话超时时间
 *
 * 影响:
 * - 故障检测速度
 * - Rebalance 频率
 * - 网络容错性
 *
 * 建议:
 * - 稳定网络: 10000-30000
 * - 不稳定网络: 30000-60000
 * - 容器环境: 30000+
 *
 * 注意: heartbeat.interval 必须小于此值
 * /
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")

/**
 * 5. heartbeat.interval.ms
 *
 * 默认: 3000 (3 秒)
 * 范围: [1, session.timeout.ms]
 * 重要性: 高
 *
 * 说明: 心跳发送间隔
 *
 * 建议: session.timeout.ms / 3
 *
 * 示例:
 * session.timeout.ms = 30000
 * heartbeat.interval.ms = 10000
 * /
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

/**
 * 6. max.poll.interval.ms
 *
 * 默认: 300000 (5 分钟)
 * 范围: [1, Int.MaxValue]
 * 重要性: 高
 *
 * 说明: 两次 poll 的最大间隔
 *
 * 影响:
 * - 消费超时检测
 * - 处理时间限制
 *
 * 建议:
 * - 快速处理: 60000 (1 分钟)
 * - 普通处理: 300000 (5 分钟)
 * - 批量处理: 600000-1800000 (10-30 分钟)
 *
 * 确保:
 * max.poll.records / processing_rate < max.poll.interval
 * /
props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000")

/**
 * 7. max.poll.records
 *
 * 默认: 500
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 单次 poll 最大记录数
 *
 * 建议:
 * - 低延迟: 100-300
 * - 普通场景: 500
 * - 高吞吐: 1000-5000
 *
 * 计算公式:
 * max_poll_records <= processing_rate * max_poll_interval
 * /
props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "500")
```

### Offset 提交配置

```scala
/**
 * Offset 提交配置
 * /

/**
 * 8. enable.auto.commit
 *
 * 默认: true
 * 重要性: 高
 *
 * 说明: 是否自动提交 Offset
 *
 * 影响:
 * - 消费语义
 * - 消息重复/丢失
 * - 编码复杂度
 *
 * 建议:
 * - 简单场景: true
 * - 精确控制: false
 * - 至少一次: false + 手动提交
 * /
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")

/**
 * 9. auto.commit.interval.ms
 *
 * 默认: 5000 (5 秒)
 * 范围: [1, Long.MaxValue]
 * 重要性: 中
 *
 * 说明: 自动提交间隔
 *
 * 建议:
 * - 低延迟: 1000-3000
 * - 普通场景: 5000
 * - 高吞吐: 10000+
 *
 * 注意: 仅在 enable.auto.commit=true 时有效
 * /
props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, "5000")

/**
 * 10. auto.offset.reset
 *
 * 默认: latest
 * 可选值: earliest, latest, none
 * 重要性: 高
 *
 * 说明: 没有 Offset 时的策略
 *
 * 选择:
 * - earliest: 从最早开始 (可能重复)
 * - latest: 从最新开始 (可能丢失)
 * - none: 抛出异常 (需要手动处理)
 *
 * 建议:
 * - 新业务: latest
 * - 历史数据: earliest
 * - 严格模式: none
 * /
props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")

/**
 * 11. isolation.level
 *
 * 默认: read_uncommitted
 * 可选值: read_uncommitted, read_committed
 * 重要性: 中
 *
 * 说明: 事务隔离级别
 *
 * 选择:
 * - read_uncommitted: 读取所有消息 (包括未提交)
 * - read_committed: 只读取已提交的消息
 *
 * 建议:
 * - 需要事务语义: read_committed
 * - 普通场景: read_uncommitted
 * /
props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")
```

### 分区分配配置

```scala
/**
 * 分区分配配置
 * /

/**
 * 12. partition.assignment.strategy
 *
 * 默认: classOf[RangeAssignor]
 * 重要性: 高
 *
 * 说明: 分区分配策略
 *
 * 可选:
 * - org.apache.kafka.clients.consumer.RangeAssignor
 * - org.apache.kafka.clients.consumer.RoundRobinAssignor
 * - org.apache.kafka.clients.consumer.StickyAssignor
 * - org.apache.kafka.clients.consumer.CooperativeStickyAssignor
 *
 * 建议:
 * - 普通场景: StickyAssignor
 * - 最小影响: CooperativeStickyAssignor
 * - 多 Topic: RoundRobinAssignor
 * /
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
          "org.apache.kafka.clients.consumer.StickyAssignor")

/**
 * 13. group.instance.id
 *
 * 默认: null
 * 重要性: 高
 *
 * 说明: 静态成员 ID
 *
 * 使用场景:
 * - 容器部署
 * - 频繁重启
 * - 需要 stable 分配
 *
 * 建议:
 * - 使用唯一标识
 * - 例如: ${HOSTNAME}-${PORT}
 * /
props.put(ConsumerConfig.GROUP_INSTANCE_ID_CONFIG, "consumer-1")
```

### 网络与 Fetch 配置

```scala
/**
 * 网络与 Fetch 配置
 * /

/**
 * 14. fetch.min.bytes
 *
 * 默认: 1
 * 范围: [0, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 最小拉取字节数
 *
 * 建议:
 * - 低延迟: 1
 * - 高吞吐: 102400 (100 KB)
 * - 批量: 1048576 (1 MB)
 * /
props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1024")

/**
 * 15. fetch.max.wait.ms
 *
 * 默认: 500
 * 范围: [0, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 最大等待时间
 *
 * 建议:
 * - 低延迟: 100
 * - 普通场景: 500
 * - 高吞吐: 1000-5000
 * /
props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "500")

/**
 * 16. fetch.max.bytes
 *
 * 默认: 57671680 (55 MB)
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 单次拉取最大字节数
 *
 * 建议: 根据内存和处理能力调整
 * /
props.put(ConsumerConfig.FETCH_MAX_BYTES_CONFIG, "52428800")

/**
 * 17. max.partition.fetch.bytes
 *
 * 默认: 1048576 (1 MB)
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 单分区最大拉取字节数
 *
 * 建议:
 * - 小消息: 524288 (512 KB)
 * - 大消息: 10485760 (10 MB)
 * /
props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, "1048576")

/**
 * 18. connections.max.idle.ms
 *
 * 默认: 540000 (9 分钟)
 * 范围: [0, Long.MaxValue]
 * 重要性: 低
 *
 * 说明: 连接最大空闲时间
 *
 * 建议: 保持默认值
 * /
props.put(ConsumerConfig.CONNECTIONS_MAX_IDLE_MS_CONFIG, "540000")

/**
 * 19. request.timeout.ms
 *
 * 默认: 40000 (40 秒)
 * 范围: [1, Int.MaxValue]
 * 重要性: 中
 *
 * 说明: 请求超时时间
 *
 * 建议:
 * - 正常网络: 30000-40000
 * - 慢速网络: 60000+
 * /
props.put(ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG, "40000")
```

### 性能调优配置

```scala
/**
 * 性能调优配置
 * /

/**
 * 20. receive.buffer.bytes
 *
 * 默认: 65536 (64 KB)
 * 范围: [-1, Int.MaxValue]
 * 重要性: 低
 *
 * 说明: TCP 接收缓冲区大小
 *
 * 建议:
 * - -1: 使用 OS 默认值
 * - 高吞吐: 131072 (128 KB) 或更大
 * /
props.put(ConsumerConfig.RECEIVE_BUFFER_CONFIG, "-1")

/**
 * 21. send.buffer.bytes
 *
 * 默认: 131072 (128 KB)
 * 范围: [-1, Int.MaxValue]
 * 重要性: 低
 *
 * 说明: TCP 发送缓冲区大小
 *
 * 建议: 使用 OS 默认值 (-1)
 * /
props.put(ConsumerConfig.SEND_BUFFER_CONFIG, "-1")

/**
 * 22. metadata.max.age.ms
 *
 * 默认: 300000 (5 分钟)
 * 范围: [0, Long.MaxValue]
 * 重要性: 低
 *
 * 说明: 元数据最大有效时间
 *
 * 建议: 保持默认值
 * /
props.put(ConsumerConfig.METADATA_MAX_AGE_CONFIG, "300000")

/**
 * 23. reconnect.backoff.ms
 *
 * 默认: 50
 * 范围: [0, Long.MaxValue]
 * 重要性: 低
 *
 * 说明: 重连等待时间
 *
 * 建议: 保持默认值
 * /
props.put(ConsumerConfig.RECONNECT_BACKOFF_MS_CONFIG, "50")

/**
 * 24. retry.backoff.ms
 *
 * 默认: 100
 * 范围: [0, Long.MaxValue]
 * 重要性: 低
 *
 * 说明: 重试等待时间
 *
 * 建议: 保持默认值
 * /
props.put(ConsumerConfig.RETRY_BACKOFF_MS_CONFIG, "100")
```

## 11.3 配置模板

### 低延迟配置

```scala
/**
 * 低延迟配置模板
 *
 * 适用场景:
 * - 实时处理
 * - 低延迟要求
 * - 快速响应
 * /
object LowLatencyConfig {
    def apply(): Properties = {
        val props = new Properties()

        // 基础配置
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092")
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "low-latency-consumer")

        // 会话配置
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "10000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "3000")

        // 处理配置
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "60000")
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "100")

        // Fetch 配置
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1")
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "100")

        // Offset 配置
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")

        props
    }
}
```

### 高吞吐配置

```scala
/**
 * 高吞吐配置模板
 *
 * 适用场景:
 * - 批量处理
 * - 离线分析
 * - 数据同步
 * /
object HighThroughputConfig {
    def apply(): Properties = {
        val props = new Properties()

        // 基础配置
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092")
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "high-throughput-consumer")

        // 会话配置
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

        // 处理配置
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "600000")
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "2000")

        // Fetch 配置
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1048576")  // 1MB
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "1000")
        props.put(ConsumerConfig.FETCH_MAX_BYTES_CONFIG, "52428800") // 50MB
        props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, "10485760") // 10MB

        // Offset 配置
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")

        // 分配策略
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                  "org.apache.kafka.clients.consumer.RoundRobinAssignor")

        props
    }
}
```

### 静态成员配置

```scala
/**
 * 静态成员配置模板
 *
 * 适用场景:
 * - 容器部署
 * - 频繁重启
 * - 需要稳定分配
 * /
object StaticMemberConfig {
    def apply(instanceId: String): Properties = {
        val props = new Properties()

        // 基础配置
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092")
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "static-consumer-group")

        // 静态成员配置
        props.put(ConsumerConfig.GROUP_INSTANCE_ID_CONFIG, instanceId)

        // 会话配置 (宽容一些)
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "60000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "20000")

        // 处理配置
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "600000")

        // Offset 配置
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")

        // 分配策略
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                  "org.apache.kafka.clients.consumer.StickyAssignor")

        props
    }
}
```

### 精确一次配置

```scala
/**
 * 精确一次配置模板
 *
 * 适用场景:
 * - 需要 exactly-once 语义
 * - 事务处理
 * - 数据一致性要求高
 * /
object ExactlyOnceConfig {
    def apply(): Properties = {
        val props = new Properties()

        // 基础配置
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092")
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "exactly-once-consumer")

        // 事务隔离级别
        props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")

        // 手动提交
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")

        // 会话配置
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "30000")
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "10000")

        // 处理配置
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000")
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "500")

        props
    }
}
```

## 11.4 配置验证

### 配置检查清单

```scala
/**
 * 配置验证
 * /
object ConfigValidator {
    /**
     * 验证 Consumer 配置
     * /
    def validate(props: Properties): List[String] = {
        val errors = mutable.ListBuffer[String]()

        // 1. 必填配置
        if (!props.containsKey(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG)) {
            errors += "bootstrap.servers 未配置"
        }

        if (!props.containsKey(ConsumerConfig.GROUP_ID_CONFIG)) {
            errors += "group.id 未配置"
        }

        // 2. 会话配置验证
        val sessionTimeout = props.getProperty(
            ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG,
            "45000"
        ).toInt

        val heartbeatInterval = props.getProperty(
            ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG,
            "3000"
        ).toInt

        if (heartbeatInterval > sessionTimeout / 3) {
            errors += s"heartbeat.interval ($heartbeatInterval) 应该 <= session.timeout/3"
        }

        // 3. 处理配置验证
        val maxPollRecords = props.getProperty(
            ConsumerConfig.MAX_POLL_RECORDS_CONFIG,
            "500"
        ).toInt

        if (maxPollRecords < 1) {
            errors += "max.poll.records 必须 > 0"
        }

        // 4. 分配策略验证
        val assignor = props.getProperty(
            ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG
        )

        if (assignor != null) {
            val validAssignors = Set(
                "org.apache.kafka.clients.consumer.RangeAssignor",
                "org.apache.kafka.clients.consumer.RoundRobinAssignor",
                "org.apache.kafka.clients.consumer.StickyAssignor",
                "org.apache.kafka.clients.consumer.CooperativeStickyAssignor"
            )

            if (!validAssignors.contains(assignor)) {
                errors += s"未知的分配策略: $assignor"
            }
        }

        errors.toList
    }

    /**
     * 生成配置建议
     * /
    def recommend(props: Properties): List[String] = {
        val recommendations = mutable.ListBuffer[String]()

        val autoCommit = props.getProperty(
            ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG,
            "true"
        ).toBoolean

        if (autoCommit) {
            recommendations += "考虑禁用自动提交以获得更好的控制"
        }

        val sessionTimeout = props.getProperty(
            ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG,
            "45000"
        ).toInt

        if (sessionTimeout < 10000) {
            recommendations += "session.timeout 设置较小，可能导致频繁 Rebalance"
        }

        recommendations.toList
    }
}
```

## 11.5 小结

合理配置是确保 Kafka 消费者正常运行的关键：

1. **Broker 配置**：优化 Topic 和 Coordinator 参数
2. **Consumer 配置**：根据场景选择合适的参数
3. **配置模板**：使用预设的配置模板快速部署
4. **配置验证**：上线前验证配置的合理性
5. **持续优化**：根据实际运行情况调整配置

## 参考文档

- [08-rebalance-optimization.md](./08-rebalance-optimization.md) - Rebalance 优化
- [10-coordinator-troubleshooting.md](./10-coordinator-troubleshooting.md) - 故障排查
- [09-coordinator-monitoring.md](./09-coordinator-monitoring.md) - 监控指标
