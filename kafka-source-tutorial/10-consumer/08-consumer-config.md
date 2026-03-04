# 08. Consumer 配置详解

本文档详细介绍 Kafka Consumer 的所有配置参数及其影响。

## 目录
- [1. 基础配置](#1-基础配置)
- [2. 消费组配置](#2-消费组配置)
- [3. Fetch 配置](#3-fetch-配置)
- [4. 心跳与会话配置](#4-心跳与会话配置)
- [5. 性能优化配置](#5-性能优化配置)
- [6. 配置示例](#6-配置示例)

---

## 1. 基础配置

### 1.1 必需配置

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `bootstrap.servers` | list | Kafka 集群初始连接地址 |
| `key.deserializer` | class | Key 的反序列化类 |
| `value.deserializer` | class | Value 的反序列化类 |

**常用序列化器**:
```java
// 字符串
org.apache.kafka.common.serialization.StringDeserializer

// 字节数组
org.apache.kafka.common.serialization.ByteArrayDeserializer

// JSON (自定义)
org.apache.kafka.common.serialization.JsonDeserializer
```

### 1.2 客户端标识

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `client.id` | "" | 客户端标识，用于日志和监控 |
| `group.id` | null | 消费组 ID，指定则启用消费组模式 |

---

## 2. 消费组配置

### 2.1 Offset 管理

| 配置项 | 默认值 | 可选值 | 说明 |
|--------|--------|--------|------|
| `auto.offset.reset` | latest | earliest/latest/none | 无初始 Offset 时的策略 |
| `enable.auto.commit` | true | true/false | 是否自动提交 Offset |
| `auto.commit.interval.ms` | 5000 | - | 自动提交间隔 |

**auto.offset.reset 详解**:
- `earliest`: 从最早的可用 Offset 开始消费
- `latest`: 从最新的 Offset 开始消费 (默认)
- `none`: 无初始 Offset 时抛出异常

### 2.2 分区分配策略

| 配置项 | 默认值 | 可选值 |
|--------|--------|--------|
| `partition.assignment.strategy` | RangeAssignor | Range/RoundRobin/Sticky/CooperativeSticky |

**分配策略对比**:

| 策略 | 特点 | 适用场景 |
|------|------|----------|
| RangeAssignor | 按 Topic 范围分配 | 分区数均匀 |
| RoundRobinAssignor | 轮询分配 | 消费组简单 |
| StickyAssignor | 粘性分配，减少变动 | 频繁 Rebalance |
| CooperativeStickyAssignor | 增量 Rebalance | Kafka 2.4+ |

### 2.3 静态成员

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `group.instance.id` | null | 静态成员 ID，重启后保持分区分配 |

---

## 3. Fetch 配置

### 3.1 基本 Fetch 参数

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `fetch.min.bytes` | 1 | 最小拉取字节数 |
| `fetch.max.bytes` | 52428800 | 单次 Fetch 最大字节数 (50MB) |
| `fetch.max.wait.ms` | 500 | 等待 fetch.min.bytes 的最大时间 |

**调优建议**:
- 增大 `fetch.min.bytes` 可减少空轮询，降低 CPU
- 增大 `fetch.max.wait.ms` 可增加批量大小

### 3.2 分区级 Fetch 限制

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `max.partition.fetch.bytes` | 1048576 | 单个分区最大拉取字节数 (1MB) |
| `max.poll.records` | 500 | 单次 poll() 返回的最大记录数 |

### 3.3 隔离级别

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `isolation.level` | read_uncommitted | 隔离级别 |

**隔离级别**:
- `read_uncommitted`: 读取所有消息 (包括事务未提交的)
- `read_committed`: 只读取已提交的消息 (Consumer 事务隔离)

---

## 4. 心跳与会话配置

### 4.1 会话超时

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `session.timeout.ms` | 45000 | 会话超时时间 |
| `heartbeat.interval.ms` | 3000 | 心跳发送间隔 |

**配置关系**:
```
session.timeout.ms >= 3 * heartbeat.interval.ms
```

### 4.2 最大轮询间隔

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `max.poll.interval.ms` | 300000 | 两次 poll() 调用之间的最大延迟 |

**重要**: 如果业务处理时间超过此值，Consumer 会被踢出消费组！

### 4.3 Rebalance 超时

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `rebalance.timeout.ms` | 300000 | Rebalance 最大等待时间 |

---

## 5. 性能优化配置

### 5.1 网络配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `connections.max.idle.ms` | 540000 | 连接空闲超时 |
| `request.timeout.ms` | 30000 | 请求超时时间 |
| `default.api.timeout.ms` | 60000 | 默认 API 调用超时 |

### 5.2 缓冲区配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `send.buffer.bytes` | 131072 | TCP 发送缓冲区 |
| `receive.buffer.bytes` | 65536 | TCP 接收缓冲区 |
| `socket.connection.setup.timeout.ms` | 10000 | 连接建立超时 |

---

## 6. 配置示例

### 6.1 高吞吐消费

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("group.id", "high-throughput-consumer");
props.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
props.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");

// 批量拉取
props.put("fetch.min.bytes", 100000);     // 100KB
props.put("fetch.max.wait.ms", 500);      // 最多等 500ms
props.put("max.poll.records", 1000);      // 单次最多 1000 条

// 减少 Rebalance 影响
props.put("session.timeout.ms", 30000);
props.put("heartbeat.interval.ms", 10000);

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
```

### 6.2 低延迟消费

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092");
props.put("group.id", "low-latency-consumer");
props.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
props.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");

// 立即返回
props.put("fetch.min.bytes", 1);
props.put("fetch.max.wait.ms", 0);
props.put("max.poll.records", 1);

// 禁用自动提交，手动控制
props.put("enable.auto.commit", "false");

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
```

### 6.3 可靠消费 (手动提交)

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("group.id", "reliable-consumer");
props.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
props.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");

// 从最早开始，确保不丢消息
props.put("auto.offset.reset", "earliest");

// 禁用自动提交
props.put("enable.auto.commit", "false");

// 增加会话超时，避免频繁 Rebalance
props.put("session.timeout.ms", 60000);
props.put("heartbeat.interval.ms", 5000);

// 增加最大轮询间隔，处理长耗时任务
props.put("max.poll.interval.ms", 600000);  // 10 分钟

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
consumer.subscribe(Arrays.asList("topic"));

try {
    while (true) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
        for (ConsumerRecord<String, String> record : records) {
            try {
                process(record);
            } catch (Exception e) {
                // 处理失败，可选择重试或跳过
                log.error("Process failed", e);
            }
        }
        // 同步提交，确保处理完再提交
        consumer.commitSync();
    }
} finally {
    consumer.close();
}
```

### 6.4 事务消费 (Exactly Once)

```java
// Consumer 配置
Properties consumerProps = new Properties();
consumerProps.put("bootstrap.servers", "kafka1:9092");
consumerProps.put("group.id", "eos-consumer");
consumerProps.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
consumerProps.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");

// 只读已提交的消息
consumerProps.put("isolation.level", "read_committed");

// 禁用自动提交
consumerProps.put("enable.auto.commit", "false");

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);

// Producer 配置 (事务)
Properties producerProps = new Properties();
producerProps.put("bootstrap.servers", "kafka1:9092");
producerProps.put("transactional.id", "my-transactional-id");
producerProps.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
producerProps.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");
producerProps.put("enable.idempotence", "true");
producerProps.put("acks", "all");

KafkaProducer<String, String> producer = new KafkaProducer<>(producerProps);
producer.initTransactions();

consumer.subscribe(Arrays.asList("input-topic"));

while (true) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    if (records.isEmpty()) continue;

    producer.beginTransaction();
    try {
        for (ConsumerRecord<String, String> record : records) {
            // 处理并转发
            producer.send(new ProducerRecord<>("output-topic", transform(record)));
        }

        // 将消费 Offset 作为事务的一部分提交
        producer.sendOffsetsToTransaction(
            consumer.position(consumer.assignment()),
            consumer.groupMetadata()
        );

        producer.commitTransaction();
    } catch (Exception e) {
        producer.abortTransaction();
        throw e;
    }
}
```

---

**配置参考**: [Apache Kafka Documentation](https://kafka.apache.org/documentation/#consumerconfigs)
