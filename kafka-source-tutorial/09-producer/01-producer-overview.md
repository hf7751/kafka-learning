# 01. Kafka Producer 架构概述

本文档介绍 Kafka Producer 的整体架构和核心组件，帮助读者建立对生产者客户端的全局认识。

## 目录
- [1. Producer 架构概览](#1-producer-架构概览)
- [2. 核心组件详解](#2-核心组件详解)
- [3. 消息发送流程](#3-消息发送流程)
- [4. 关键配置参数](#4-关键配置参数)

---

## 1. Producer 架构概览

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        KafkaProducer                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   主线程      │    │   RecordAccumulator│   │ Sender 线程   │  │
│  │              │    │     (缓冲区)        │    │              │  │
│  │  1. 序列化    │───▶│                  │───▶│  批量发送      │  │
│  │  2. 分区计算  │    │  - 按 TopicPartition│   │              │  │
│  │  3. 写入缓冲  │    │    组织批次        │    │  - 网络 I/O   │  │
│  │              │    │  - 压缩数据        │    │  - 接收响应    │  │
│  └──────────────┘    └──────────────────┘    └──────────────┘  │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐                      │
│  │  拦截器链     │    │   Metadata 管理   │                      │
│  │              │    │                  │                      │
│  │  - 预处理     │    │  - 获取分区信息   │                      │
│  │  - 后处理     │    │  - 发现 Broker    │                      │
│  └──────────────┘    └──────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计特点

| 特性 | 说明 | 优势 |
|-----|------|------|
| **异步发送** | 主线程写入缓冲区即返回 | 高吞吐、低延迟 |
| **批量处理** | 多条消息组成批次发送 | 减少网络开销 |
| **压缩支持** | 支持 GZIP/Snappy/LZ4/ZSTD | 减少带宽占用 |
| **可重试** | 自动重试失败的请求 | 提高可靠性 |

---

## 2. 核心组件详解

### 2.1 RecordAccumulator - 消息缓冲区

```scala
/**
 * 缓冲区核心数据结构
 */
class RecordAccumulator {
  // 按 TopicPartition 组织的批次队列
  private val batches: ConcurrentMap[TopicPartition, Deque[ProducerBatch]]

  // 已使用的内存大小
  private val bufferUsed: AtomicLong

  // 未发送完成的批次计数
  private val incomplete: IncompleteBatches
}
```

**关键参数**:
- `buffer.memory`: 总缓冲区大小 (默认 32MB)
- `batch.size`: 单个批次大小 (默认 16KB)
- `linger.ms`: 发送等待时间 (默认 0)

### 2.2 Sender 线程

```scala
/**
 * 后台发送线程
 */
class Sender extends Runnable {
  override def run(): Unit = {
    while (running) {
      // 1. 从缓冲区获取可发送的批次
      val ready = accumulator.ready(cluster, now)

      // 2. 创建发送请求
      val requests = createProduceRequests(ready)

      // 3. 执行网络发送
      client.send(requests, now)

      // 4. 处理响应
      client.poll(pollTimeout, now)
    }
  }
}
```

### 2.3 Partitioner - 分区器

```java
/**
 * 分区选择策略
 */
public interface Partitioner {
    // 计算消息应该发送到哪个分区
    int partition(String topic,
                  Object key,
                  byte[] keyBytes,
                  Object value,
                  byte[] valueBytes,
                  Cluster cluster);
}
```

**默认分区策略**:
1. 指定了 partition → 直接使用
2. 有 key → `Utils.murmur2(key) % partitionCount`
3. 无 key → 粘性分区 (2.4.0+)，优先填满一个批次

---

## 3. 消息发送流程

### 3.1 同步发送流程

```
send(record)
  │
  ▼
┌─────────────────┐
│ 1. 拦截器预处理  │
└────────┬────────┘
         ▼
┌─────────────────┐
│ 2. 序列化        │  key + value
└────────┬────────┘
         ▼
┌─────────────────┐
│ 3. 选择分区      │  partitioner.partition()
└────────┬────────┘
         ▼
┌─────────────────┐
│ 4. 写入缓冲区    │  RecordAccumulator.append()
└────────┬────────┘
         ▼
┌─────────────────┐
│ 5. 唤醒 Sender   │  触发批量发送
└────────┬────────┘
         ▼
┌─────────────────┐
│ 6. 等待结果      │  Future.get() / callback
└─────────────────┘
```

### 3.2 异步发送流程

```scala
// 异步发送，通过 Callback 接收结果
producer.send(record, new Callback() {
  override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
    if (exception != null) {
      // 处理发送失败
    } else {
      // 发送成功: metadata.offset(), metadata.partition()
    }
  }
})
```

---

## 4. 关键配置参数

### 4.1 核心配置

| 配置项 | 默认值 | 说明 | 调优建议 |
|--------|--------|------|----------|
| `bootstrap.servers` | - | Kafka 集群地址 | 配置多个 Broker |
| `key.serializer` | - | Key 序列化类 | StringSerializer / ByteArraySerializer |
| `value.serializer` | - | Value 序列化类 | 根据数据类型选择 |
| `acks` | 1 | 确认机制 | 0(最高吞吐)/1(平衡)/all(最强一致) |
| `retries` | 0 | 发送失败重试次数 | 建议设置为 Integer.MAX_VALUE |
| `delivery.timeout.ms` | 120000 | 投递超时时间 | 包含重试的总时间上限 |

### 4.2 性能优化配置

| 配置项 | 默认值 | 说明 | 调优建议 |
|--------|--------|------|----------|
| `batch.size` | 16384 | 批次大小 | 增加可提高吞吐，延迟也会增加 |
| `linger.ms` | 0 | 发送延迟 | 设为 5-100ms 提高批量效率 |
| `buffer.memory` | 33554432 | 缓冲区大小 | 根据内存和并发量调整 |
| `max.request.size` | 1048576 | 最大请求大小 | 单请求包含多条消息的总大小 |
| `compression.type` | none | 压缩类型 | lz4/snappy 平衡性能 |

### 4.3 可靠性配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enable.idempotence` | false | 启用幂等性 |
| `max.in.flight.requests.per.connection` | 5 | 单连接并发请求数 |
| `transactional.id` | - | 事务 ID |

---

## 5. 发送语义保证

### 5.1 At Most Once (最多一次)
```properties
acks=0
retries=0
```

### 5.2 At Least Once (至少一次)
```properties
acks=1
retries=3
```

### 5.3 Exactly Once (精确一次)
```properties
enable.idempotence=true
transactional.id=my-transactional-id
```

---

**下一章**: [02. RecordAccumulator 缓冲区](./02-record-accumulator.md)
