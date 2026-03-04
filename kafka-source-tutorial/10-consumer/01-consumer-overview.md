# 01. Kafka Consumer 架构概述

本文档介绍 Kafka Consumer 的整体架构和核心组件，帮助读者建立对消费者客户端的全局认识。

## 目录
- [1. Consumer 架构概览](#1-consumer-架构概览)
- [2. 核心组件详解](#2-核心组件详解)
- [3. 消费流程](#3-消费流程)
- [4. 关键配置参数](#4-关键配置参数)

---

## 1. Consumer 架构概览

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                       KafkaConsumer                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌──────────────────┐                   │
│  │  Consumer       │    │   SubscriptionState│                  │
│  │  Network Client │    │   (订阅状态管理)   │                  │
│  │                 │    │                  │                   │
│  │  - 网络连接      │    │  - 订阅的 Topic   │                   │
│  │  - 请求响应      │    │  - 分配的 Partition│                  │
│  │  - 元数据更新    │    │  - 消费位置 Offset │                  │
│  └────────┬────────┘    └──────────────────┘                   │
│           │                                                     │
│           ▼                                                     │
│  ┌──────────────────────────────────────────┐                  │
│  │            Fetcher (拉取器)               │                  │
│  │                                          │                  │
│  │  ┌──────────────┐    ┌────────────────┐ │                  │
│  │  │ Fetch Session │    │ Partition Records│ │                  │
│  │  │ - 增量拉取    │    │ - 消息缓存      │ │                  │
│  │  │ - 会话管理    │    │ - 解压解析      │ │                  │
│  │  └──────────────┘    └────────────────┘ │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                 │
│  ┌─────────────────┐    ┌──────────────────┐                   │
│  │ Consumer        │    │   Coordinator    │                   │
│  │ Interceptors    │    │   (消费组协调器)  │                   │
│  │                 │    │                  │                   │
│  │  - 消费前拦截   │◄───│  - 心跳维护      │                   │
│  │  - 提交后拦截   │    │  - Rebalance     │                   │
│  └─────────────────┘    │  - Offset 管理   │                   │
│                         └──────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 消费组模式 vs 独立消费者

**消费组模式** (推荐):
```java
// 多个消费者组成消费组，自动分区分配
props.put("group.id", "my-consumer-group");
consumer.subscribe(Arrays.asList("topic1", "topic2"));
```

特点:
- 自动负载均衡
- 自动故障转移
- 消费进度持久化

**独立消费者**:
```java
// 手动指定分区，无消费组
consumer.assign(Arrays.asList(
    new TopicPartition("topic1", 0),
    new TopicPartition("topic1", 1)
));
```

特点:
- 完全控制分区分配
- 无 Rebalance
- 需自行管理 Offset

---

## 2. 核心组件详解

### 2.1 SubscriptionState - 订阅状态

```scala
/**
 * 管理消费者的订阅状态
 */
class SubscriptionState {
  // 订阅的 Topic 集合
  private val subscription: Set[String]

  // 用户指定的分区 (assign 模式)
  private val userAssignment: Set[TopicPartition]

  // 分配的分区及其消费位置
  private val assignment: Map[TopicPartition, TopicPartitionState]
}
```

### 2.2 Fetcher - 消息拉取器

```scala
/**
 * 负责从 Broker 拉取消息
 */
class Fetcher[K, V] {
  /**
   * 发起 Fetch 请求
   */
  def fetchRecords(partition: TopicPartition,
                   minBytes: Int,
                   maxBytes: Int,
                   timeout: Long): List[ConsumerRecord[K, V]] = {
    // 1. 构建 Fetch 请求
    // 2. 发送请求到对应 Broker
    // 3. 处理响应，解压数据
    // 4. 解析 RecordBatch
  }
}
```

### 2.3 ConsumerCoordinator - 消费组协调器

```scala
/**
 * 负责消费组相关的协调工作
 */
class ConsumerCoordinator {
  // 发送心跳维持组成员身份
  def heartbeat(): Unit

  // 加入消费组 (Rebalance 第一步)
  def joinGroup(): JoinGroupResponse

  // 同步分配方案 (Rebalance 第二步)
  def syncGroup(assignment: Map[String, List[TopicPartition]]): SyncGroupResponse

  // 提交消费进度
  def commitOffsets(offsets: Map[TopicPartition, OffsetAndMetadata]): Unit
}
```

---

## 3. 消费流程

### 3.1 订阅消费流程

```
subscribe(topics) / assign(partitions)
         │
         ▼
┌─────────────────┐
│ 1. 协调器连接    │ ──► 查找 GroupCoordinator
└────────┬────────┘
         ▼
┌─────────────────┐
│ 2. 加入消费组    │ ──► JoinGroup + SyncGroup
└────────┬────────┘
         ▼
┌─────────────────┐
│ 3. 拉取消息      │ ──► Fetcher.fetchRecords()
└────────┬────────┘
         ▼
┌─────────────────┐
│ 4. 处理消息      │ ──► 用户业务逻辑
└────────┬────────┘
         ▼
┌─────────────────┐
│ 5. 提交 Offset   │ ──► commitSync() / commitAsync()
└────────┬────────┘
         │
         ▼
    循环步骤 3-5
```

### 3.2 poll() 方法详解

```java
/**
 * 拉取消息的核心方法
 */
public ConsumerRecords<K, V> poll(Duration timeout) {
    // 1. 更新元数据
    updateAssignmentMetadataIfNeeded();

    // 2. 发送心跳 (消费组模式)
    coordinator.pollHeartbeat(now);

    // 3. 发起 Fetch 请求
    fetcher.sendFetches();

    // 4. 处理网络响应
    client.poll(timeout);

    // 5. 返回解析后的消息
    return fetcher.fetchedRecords();
}
```

### 3.3 Offset 提交策略

**自动提交** (默认):
```java
props.put("enable.auto.commit", "true");
props.put("auto.commit.interval.ms", "5000");
```

**手动同步提交**:
```java
// 处理完消息后同步提交
try {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    for (ConsumerRecord<String, String> record : records) {
        process(record);
    }
    consumer.commitSync();  // 阻塞直到提交成功
} catch (Exception e) {
    // 处理异常，可重试
}
```

**手动异步提交**:
```java
// 异步提交，不阻塞消费
consumer.commitAsync((offsets, exception) -> {
    if (exception != null) {
        // 记录失败，稍后重试
    }
});
```

**精细化提交**:
```java
// 按分区提交，更精确的控制
Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
offsets.put(new TopicPartition("topic", 0), new OffsetAndMetadata(100L));
consumer.commitSync(offsets);
```

---

## 4. 关键配置参数

### 4.1 基础配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `bootstrap.servers` | - | Kafka 集群地址 |
| `group.id` | - | 消费组 ID (可选) |
| `key.deserializer` | - | Key 反序列化类 |
| `value.deserializer` | - | Value 反序列化类 |

### 4.2 消费组配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `auto.offset.reset` | latest | 无初始 Offset 时的策略: earliest/latest/none |
| `enable.auto.commit` | true | 是否自动提交 Offset |
| `auto.commit.interval.ms` | 5000 | 自动提交间隔 |
| `partition.assignment.strategy` | RangeAssignor | 分区分配策略 |

### 4.3 Fetch 配置

| 配置项 | 默认值 | 说明 | 调优建议 |
|--------|--------|------|----------|
| `fetch.min.bytes` | 1 | 最小拉取字节数 | 增加可减少 CPU 和网络开销 |
| `fetch.max.bytes` | 52428800 | 最大拉取字节数 | 根据内存调整 |
| `fetch.max.wait.ms` | 500 | 最大等待时间 | 配合 fetch.min.bytes |
| `max.poll.records` | 500 | 单次 poll 最大记录数 | 根据处理能力调整 |
| `max.poll.interval.ms` | 300000 | 两次 poll 最大间隔 | 防止被踢出消费组 |

### 4.4 心跳与会话

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `heartbeat.interval.ms` | 3000 | 心跳间隔 |
| `session.timeout.ms` | 45000 | 会话超时时间 |
| `max.poll.interval.ms` | 300000 | 最大消费间隔 |

**配置关系**:
```
session.timeout.ms >= 3 * heartbeat.interval.ms
```

---

## 5. 消费模式对比

### 5.1 自动提交 vs 手动提交

| 特性 | 自动提交 | 手动同步提交 | 手动异步提交 |
|------|---------|-------------|-------------|
| 代码复杂度 | 低 | 中 | 中 |
| 一致性 | 可能重复消费 | 精确控制 | 可能丢失 |
| 吞吐量 | 高 | 中 | 高 |
| 适用场景 | 容忍重复 | 需要精确控制 | 高吞吐场景 |

### 5.2 消费语义

**At Most Once**:
```java
// 先提交，后处理
consumer.commitSync();
process(records);
```

**At Least Once**:
```java
// 先处理，后提交
process(records);
consumer.commitSync();
```

**Exactly Once** (配合事务):
```java
// 消费 + 生产 事务
producer.initTransactions();
producer.beginTransaction();

for (ConsumerRecord record : records) {
    producer.send(transform(record));
}

// 发送 Offset 到事务 Topic
producer.sendOffsetsToTransaction(consumer.position(), consumer.groupMetadata());
producer.commitTransaction();
```

---

**下一章**: [02. Fetcher 拉取机制](./02-fetcher-mechanism.md)
