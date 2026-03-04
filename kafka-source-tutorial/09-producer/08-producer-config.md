# 08. Producer 配置详解

本文档详细介绍 Kafka Producer 的所有配置参数及其影响。

## 目录
- [1. 基础配置](#1-基础配置)
- [2. 性能优化配置](#2-性能优化配置)
- [3. 可靠性配置](#3-可靠性配置)
- [4. 安全配置](#4-安全配置)
- [5. 配置示例](#5-配置示例)

---

## 1. 基础配置

### 1.1 必需配置

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `bootstrap.servers` | list | Kafka 集群初始连接地址，格式: `host1:port1,host2:port2` |
| `key.serializer` | class | Key 的序列化类 |
| `value.serializer` | class | Value 的序列化类 |

**示例**:
```java
props.put("bootstrap.servers", "localhost:9092,localhost:9093");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");
```

### 1.2 客户端标识

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `client.id` | "" | 客户端标识，用于日志和监控 |

---

## 2. 性能优化配置

### 2.1 批量发送

| 配置项 | 默认值 | 说明 | 调优建议 |
|--------|--------|------|----------|
| `batch.size` | 16384 | 批量发送的字节数上限 | 增加可提高吞吐，但会增加延迟 |
| `linger.ms` | 0 | 发送前等待时间 | 设为 5-100ms 以积累更多消息 |
| `buffer.memory` | 33554432 | 生产者缓冲区总大小 | 根据内存和并发量调整 |

**调优公式**:
```
缓冲区大小 = 单分区消息量 × 分区数 × 副本系数
```

### 2.2 压缩配置

| 配置项 | 默认值 | 可选值 | 说明 |
|--------|--------|--------|------|
| `compression.type` | none | none/gzip/snappy/lz4/zstd | 消息压缩类型 |

**压缩算法对比**:

| 算法 | 压缩比 | CPU 占用 | 建议场景 |
|------|--------|----------|----------|
| none | 1x | 无 | 内网、低延迟场景 |
| snappy | 2-2.2x | 低 | 默认推荐，平衡选择 |
| lz4 | 2-2.5x | 很低 | 高吞吐场景 |
| gzip | 2.5-3x | 高 | 带宽敏感场景 |
| zstd | 2.8-3.5x | 中 | Kafka 2.1+ 推荐 |

### 2.3 网络配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `max.block.ms` | 60000 | `send()` 和 `partitionsFor()` 的最大阻塞时间 |
| `request.timeout.ms` | 30000 | 请求超时时间 |
| `metadata.max.age.ms` | 300000 | 元数据刷新间隔 |
| `connections.max.idle.ms` | 540000 | 连接空闲超时时间 |
| `send.buffer.bytes` | 131072 | TCP 发送缓冲区大小 |
| `receive.buffer.bytes` | 65536 | TCP 接收缓冲区大小 |

---

## 3. 可靠性配置

### 3.1 确认机制

| 配置项 | 默认值 | 可选值 | 说明 |
|--------|--------|--------|------|
| `acks` | 1 | 0/1/all | Leader 确认模式 |

**acks 详解**:
- `acks=0`: 不等待确认，最高吞吐，可能丢数据
- `acks=1`: 等待 Leader 确认，平衡方案
- `acks=all`: 等待 ISR 中所有副本确认，最强一致性

### 3.2 重试配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `retries` | 0 | 发送失败重试次数 |
| `retry.backoff.ms` | 100 | 重试间隔 |
| `delivery.timeout.ms` | 120000 | 投递总超时时间 |
| `max.in.flight.requests.per.connection` | 5 | 单连接并发请求数 |

**幂等性配置**:
```properties
enable.idempotence=true
max.in.flight.requests.per.connection=5
retries=Integer.MAX_VALUE
acks=all
```

启用幂等性后，即使重试也不会导致消息重复。

### 3.3 事务配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `transactional.id` | null | 事务标识符 |
| `transaction.timeout.ms` | 60000 | 事务超时时间 |

---

## 4. 安全配置

### 4.1 SSL 配置

| 配置项 | 说明 |
|--------|------|
| `security.protocol` | 安全协议: PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL |
| `ssl.truststore.location` | 信任库路径 |
| `ssl.truststore.password` | 信任库密码 |
| `ssl.keystore.location` | 密钥库路径 |
| `ssl.keystore.password` | 密钥库密码 |

### 4.2 SASL 配置

| 配置项 | 说明 |
|--------|------|
| `sasl.mechanism` | SASL 机制: GSSAPI, PLAIN, SCRAM-SHA-256 等 |
| `sasl.jaas.config` | JAAS 配置 |

---

## 5. 配置示例

### 5.1 高吞吐场景

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");

// 批量优化
props.put("batch.size", 32768);        // 32KB
props.put("linger.ms", 20);            // 等待 20ms
props.put("buffer.memory", 67108864);  // 64MB

// 压缩
props.put("compression.type", "lz4");

// 异步确认
props.put("acks", "1");

Producer<String, String> producer = new KafkaProducer<>(props);
```

### 5.2 低延迟场景

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");

// 立即发送
props.put("linger.ms", 0);
props.put("batch.size", 1);

// 快速失败
props.put("retries", 0);
props.put("acks", "0");

Producer<String, String> producer = new KafkaProducer<>(props);
```

### 5.3 高可靠场景

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");

// 最强可靠性
props.put("enable.idempotence", "true");
props.put("acks", "all");
props.put("retries", Integer.MAX_VALUE);
props.put("delivery.timeout.ms", 120000);

// 降低并发避免乱序
props.put("max.in.flight.requests.per.connection", 5);

Producer<String, String> producer = new KafkaProducer<>(props);
```

### 5.4 事务场景

```java
Properties props = new Properties();
props.put("bootstrap.servers", "kafka1:9092,kafka2:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");

// 事务配置
props.put("transactional.id", "my-producer-id");
props.put("enable.idempotence", "true");
props.put("acks", "all");

Producer<String, String> producer = new KafkaProducer<>(props);

// 初始化事务
producer.initTransactions();

try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("topic", "key", "value"));
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

---

**配置参考**: [Apache Kafka Documentation](https://kafka.apache.org/documentation/#producerconfigs)
