# 10. 事务配置详解

## 本章导读

本章详细介绍 Kafka 事务相关的配置参数，包括生产者、消费者和 Broker 端的配置，以及性能调优和最佳实践。

---

## 1. 生产者配置

### 1.1 必需配置

```properties
# ========================================
# 必需配置: 事务 ID
# ========================================
# 唯一标识事务生产者
# 必须: 是
# 默认值: null
transactional.id=order-processor-1

# ========================================
# 必需配置: ACK 确认模式
# ========================================
# 事务要求所有副本确认
# 必须: 是（使用事务时）
# 默认值: 1
# 可选值: 0, 1, all/-1
acks=all

# ========================================
# 自动配置: 幂等性
# ========================================
# 事务自动启用幂等性
# 必须: 否（自动设置）
# 默认值: false（设置 transactional.id 后自动为 true）
enable.idempotence=true
```

### 1.2 超时配置

```properties
# ========================================
# 事务超时时间
# ========================================
# 单个事务的最大执行时间
# 必须: 否
# 默认值: 60000 (1分钟)
# 最大值: transaction.max.timeout.ms (Broker 配置)
transaction.timeout.ms=60000

# ========================================
# 请求超时时间
# ========================================
# 等待 Broker 响应的最大时间
# 必须: 否
# 默认值: 30000 (30秒)
request.timeout.ms=30000

# ========================================
# Delivery 超时时间
# ========================================
# 从发送到确认的最大时间
# 必须: 否
# 默认值: 120000 (2分钟)
delivery.timeout.ms=120000
```

### 1.3 重试配置

```properties
# ========================================
# 重试次数
# ========================================
# 发送失败时的重试次数
# 必须: 否
# 默认值: 2147483647 (Integer.MAX_VALUE)
retries=3

# ========================================
# 重试退避时间
# ========================================
# 重试前的等待时间
# 必须: 否
# 默认值: 100
retry.backoff.ms=100
```

### 1.4 性能配置

```properties
# ========================================
# 批量大小
# ========================================
# 批量发送的消息大小
# 必须: 否
# 默认值: 16384 (16KB)
batch.size=32768

# ========================================
# Linger 时间
# ========================================
# 等待批量消息的时间
# 必须: 否
# 默认值: 0
linger.ms=10

# ========================================
# 缓冲区大小
# ========================================
# 生产者可用的总内存缓冲
# 必须: 否
# 默认值: 33554432 (32MB)
buffer.memory=67108864

# ========================================
# 最大并发请求
# ========================================
# 单个连接的并发请求数
# 必须: 否
# 默认值: 5
# 注意: 事务要求值为 1（自动设置）
max.in.flight.requests.per.connection=1
```

### 1.5 网络配置

```properties
# ========================================
# 连接超时
# ========================================
# 建立连接的超时时间
# 必须: 否
# 默认值: 10000 (10秒)
connections.max.idle.ms=540000

# ========================================
# TCP 发送缓冲区
# ========================================
# TCP 发送缓冲区大小
# 必须: 否
# 默认值: 131072 (128KB)
send.buffer.bytes=131072

# ========================================
# TCP 接收缓冲区
# ========================================
# TCP 接收缓冲区大小
# 必须: 否
# 默认值: 32768 (32KB)
receive.buffer.bytes=32768
```

---

## 2. 消费者配置

### 2.1 基础配置

```properties
# ========================================
# 消费者组 ID
# ========================================
# 消费者组的唯一标识
# 必须: 是
group.id=order-processor-group

# ========================================
# 自动提交
# ========================================
# 使用事务时必须禁用
# 必须: 是（使用事务时）
# 默认值: true
enable.auto.commit=false

# ========================================
# 隔离级别
# ========================================
# 消费已提交的消息
# 必须: 否
# 默认值: read_uncommitted
# 可选值: read_uncommitted, read_committed
isolation.level=read_committed
```

### 2.2 事务相关

```properties
# ========================================
# 消费者元数据
# ========================================
# 用于 sendOffsetsToTransaction
# 必须: 否（自动获取）
# 作用: 标识消费者组
```

---

## 3. Broker 配置

### 3.1 事务配置

```properties
# ========================================
# 事务日志 Topic
# ========================================
# 内部 Topic 名称
# 必须: 否
# 默认值: __transaction_state
# 注意: 不要修改
transactional.id.expiration.ms=604800000

# ========================================
# 事务最大超时时间
# ========================================
# 生产者的 transaction.timeout.ms 不能超过此值
# 必须: 否
# 默认值: 900000 (15分钟)
transaction.max.timeout.ms=900000

# ========================================
# 事务日志分区数
# ========================================
# __transaction_state 的分区数
# 必须: 否
# 默认值: 50
# 注意: 增加需要重新创建 Topic
transaction.log.num.partitions=50

# ========================================
# Transaction Coordinator 数量
# ========================================
# 处理事务请求的线程数
# 必须: 否
# 默认值: num.network.threads
transaction.coordinator.num.threads=8

# ========================================
# Transaction Marker 最大在途请求数
# ========================================
# 同时发送的 Marker 请求数
# 必须: 否
# 默认值: 1000
transaction.marker.max.inflight.requests=1000
```

### 3.2 日志配置

```properties
# ========================================
# 日志分段大小
# ========================================
# __transaction_state 的分段大小
# 必须: 否
# 默认值: 104857600 (100MB)
log.segment.bytes=104857600

# ========================================
# 日志清理策略
# ========================================
# 支持压缩
# 必须: 否
# 默认值: delete
log.cleanup.policy=compact,delete

# ========================================
# 最小清理脏数据比率
# ========================================
# 触发压缩的脏数据比率
# 必须: 否
# 默认值: 0.5
min.cleanable.dirty.ratio=0.5

# ========================================
# 压缩延迟
# ========================================
# 消息写入后多久可以被压缩
# 必须: 否
# 默认值: 0
min.compaction.lag.ms=0
```

### 3.3 副本配置

```properties
# ========================================
# 副本因子
# ========================================
# __transaction_state 的副本因子
# 必须: 否
# 默认值: 3
default.replication.factor=3

# ========================================
# 最小同步副本数
# ========================================
# 必须同步的最小副本数
# 必须: 否
# 默认值: 2
min.insync.replicas=2

# ========================================
# Unclean Leader 选举
# ========================================
# 是否允许非同步副本成为 Leader
# 必须: 否
# 默认值: false
# 注意: 事务必须禁用
unclean.leader.election.enable=false
```

---

## 4. 配置示例

### 4.1 高吞吐配置

```properties
# ========================================
# 高吞吐场景配置
# ========================================

# 生产者配置
transactional.id=high-throughput-producer
acks=all
transaction.timeout.ms=120000

# 增大批量大小
batch.size=65536
linger.ms=20

# 增加缓冲区
buffer.memory=134217728

# 消费者配置
group.id=high-throughput-consumer
enable.auto.commit=false
isolation.level=read_committed

# 增加拉取大小
max.poll.records=500
fetch.min.bytes=1024
fetch.max.wait.ms=500
```

### 4.2 低延迟配置

```properties
# ========================================
# 低延迟场景配置
# ========================================

# 生产者配置
transactional.id=low-latency-producer
acks=all
transaction.timeout.ms=30000

# 减小批量大小
batch.size=8192
linger.ms=0

# 减少等待时间
request.timeout.ms=10000

# 消费者配置
group.id=low-latency-consumer
enable.auto.commit=false
isolation.level=read_committed

# 减少拉取大小
max.poll.records=100
fetch.min.bytes=1
```

### 4.3 高可靠性配置

```properties
# ========================================
# 高可靠性场景配置
# ========================================

# 生产者配置
transactional.id=high-reliability-producer
acks=all
transaction.timeout.ms=180000

# 增加重试次数
retries=10
retry.backoff.ms=200

# 增加超时时间
request.timeout.ms=60000
delivery.timeout.ms=300000

# 消费者配置
group.id=high-reliability-consumer
enable.auto.commit=false
isolation.level=read_committed

# Broker 配置
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
```

---

## 5. 性能调优

### 5.1 吞吐量优化

```properties
# ========================================
# 吞吐量优化
# ========================================

# 1. 增大批量大小
batch.size=65536
linger.ms=20

# 2. 增加缓冲区
buffer.memory=134217728

# 3. 调整事务超时
transaction.timeout.ms=120000

# 4. 优化网络
# - 使用千兆网络
# - 减少网络延迟

# 5. 优化磁盘
# - 使用 SSD
# - 增加 I/O 带宽
```

### 5.2 延迟优化

```properties
# ========================================
# 延迟优化
# ========================================

# 1. 减小批量大小
batch.size=8192
linger.ms=0

# 2. 减少超时时间
request.timeout.ms=10000
transaction.timeout.ms=30000

# 3. 优化网络
# - 减少网络跳数
# - 使用本地网络

# 4. 优化 Broker
# - 减少 GC 压力
# - 优化磁盘 I/O
```

### 5.3 可靠性优化

```properties
# ========================================
# 可靠性优化
# ========================================

# 1. 增加副本
default.replication.factor=3
min.insync.replicas=2

# 2. 禁用 unclean 选举
unclean.leader.election.enable=false

# 3. 增加重试
retries=10

# 4. 增加超时
request.timeout.ms=60000
delivery.timeout.ms=300000
```

---

## 6. 配置验证

### 6.1 配置检查清单

```java
/**
 * 配置检查清单
 */

public class TransactionConfigChecker {
    /**
     * 检查生产者配置
     */
    public static void checkProducerConfig(Properties props) {
        // 1. 检查必需配置
        if (!props.containsKey("transactional.id")) {
            throw new IllegalArgumentException("缺少 transactional.id");
        }

        if (!"all".equals(props.get("acks"))) {
            throw new IllegalArgumentException("事务必须配置 acks=all");
        }

        // 2. 检查超时配置
        long txTimeout = Long.parseLong(props.getProperty("transaction.timeout.ms", "60000"));
        if (txTimeout > 15 * 60 * 1000) {
            throw new IllegalArgumentException("transaction.timeout.ms 不能超过 15 分钟");
        }

        // 3. 检查并发配置
        int maxInFlight = Integer.parseInt(props.getProperty("max.in.flight.requests.per.connection", "5"));
        if (maxInFlight != 1) {
            throw new IllegalArgumentException("事务要求 max.in.flight.requests.per.connection=1");
        }

        // 4. 检查幂等性
        boolean enableIdempotence = Boolean.parseBoolean(props.getProperty("enable.idempotence", "false"));
        if (!enableIdempotence) {
            throw new IllegalArgumentException("事务要求启用幂等性");
        }
    }

    /**
     * 检查消费者配置
     */
    public static void checkConsumerConfig(Properties props) {
        // 1. 检查自动提交
        boolean autoCommit = Boolean.parseBoolean(props.getProperty("enable.auto.commit", "true"));
        if (autoCommit) {
            throw new IllegalArgumentException("事务要求禁用自动提交");
        }

        // 2. 检查隔离级别
        String isolationLevel = props.getProperty("isolation.level", "read_uncommitted");
        if (!"read_committed".equals(isolationLevel)) {
            throw new IllegalArgumentException("建议使用 read_committed 隔离级别");
        }
    }
}
```

### 6.2 配置测试

```java
/**
 * 配置测试
 */

public class TransactionConfigTest {
    @Test
    public void testTransactionConfig() {
        Properties props = new Properties();
        props.put("transactional.id", "test-producer");
        props.put("acks", "all");
        props.put("enable.idempotence", "true");

        TransactionConfigChecker.checkProducerConfig(props);

        KafkaProducer<String, String> producer = new KafkaProducer<>(props);
        producer.initTransactions();

        producer.close();
    }
}
```

---

## 7. 总结

### 7.1 关键配置

1. **生产者**
   - transactional.id: 必须
   - acks=all: 必须
   - enable.idempotence: 自动启用

2. **消费者**
   - enable.auto.commit=false: 必须
   - isolation.level=read_committed: 建议

3. **Broker**
   - default.replication.factor=3: 建议
   - min.insync.replicas=2: 建议

### 7.2 配置建议

| 场景 | batch.size | linger.ms | transaction.timeout.ms |
|------|-----------|-----------|----------------------|
| **高吞吐** | 65536 | 20 | 120000 |
| **低延迟** | 8192 | 0 | 30000 |
| **高可靠** | 16384 | 10 | 180000 |

### 7.3 下一步学习

- **[11-transaction-patterns.md](./11-transaction-patterns.md)** - 学习事务模式和最佳实践

---

**思考题**：
1. 为什么事务要求 max.in.flight.requests.per.connection=1？
2. transaction.timeout.ms 设置得越大越好吗？有什么副作用？
3. 如何根据业务场景选择合适的配置？
