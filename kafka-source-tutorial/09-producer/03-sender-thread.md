# 03. Sender 线程详解

本文档深入分析 Kafka Producer 的后台发送线程 Sender，了解消息如何从缓冲区发送到 Broker。

## 目录
- [1. Sender 概述](#1-sender-概述)
- [2. run() 主循环详解](#2-run-主循环详解)
- [3. 发送流程分析](#3-发送流程分析)
- [4. 响应处理流程](#4-响应处理流程)
- [5. 重试机制](#5-重试机制)
- [6. 性能优化](#6-性能优化)

---

## 1. Sender 概述

### 1.1 Sender 的职责

Sender 是 Kafka Producer 的后台 I/O 线程，负责将 RecordAccumulator 中的消息批次发送到 Kafka Broker。

```
┌─────────────────────────────────────────────────────────────────┐
│                     Sender 线程                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   runOnce    │───▶│     NetworkClient │   │    Poll      │  │
│  │              │    │                  │    │              │  │
│  │  1. ready()  │    │  - 建立连接       │    │  接收响应    │  │
│  │  2. drain()  │    │  - 发送请求       │    │  触发回调    │  │
│  │  3. send()   │    │  - 管理连接状态   │    │              │  │
│  └──────────────┘    └──────────────────┘    └──────────────┘  │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐                      │
│  │   失败处理    │    │    元数据更新     │                      │
│  │              │    │                  │                      │
│  │  - 重试机制   │    │  - 发现新节点    │                      │
│  │  - 异常分类   │    │  - 更新分区信息  │                      │
│  └──────────────┘    └──────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 与 RecordAccumulator 的协作

```
┌─────────────────────────────────────────────────────────────────┐
│                        KafkaProducer                            │
│                                                                 │
│  ┌─────────────────┐         ┌──────────────────┐              │
│  │  Record         │         │     Sender       │              │
│  │  Accumulator    │◀───────▶│                  │              │
│  │                 │ 唤醒    │  1. ready()      │              │
│  │  - 缓冲消息     │         │  2. drain()      │              │
│  │  - 管理内存     │         │  3. send()       │              │
│  └─────────────────┘         └────────┬─────────┘              │
│                                       │                        │
│                                       ▼                        │
│                              ┌──────────────────┐              │
│                              │  NetworkClient   │              │
│                              │  - 网络 I/O      │              │
│                              └──────────────────┘              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 核心参数

```java
public class Sender implements Runnable {
    // 网络客户端
    private final KafkaClient client;
    // 消息缓冲区
    private final RecordAccumulator accumulator;
    // 元数据管理
    private final ProducerMetadata metadata;
    // 是否正在运行
    private volatile boolean running = true;
    // 是否强制关闭
    private volatile boolean forceClose;
    // 发送请求管理
    private final SenderMetrics sensors;
}
```

---

## 2. run() 主循环详解

### 2.1 主循环结构

```java
@Override
public void run() {
    log.debug("Starting Kafka producer I/O thread.");

    // 主循环：只要 running 为 true 就持续运行
    while (running) {
        try {
            runOnce();
        } catch (Exception e) {
            log.error("Uncaught error in kafka producer I/O thread: ", e);
        }
    }

    // 关闭处理...
    log.debug("Beginning shutdown of Kafka producer I/O thread, " +
              "sending remaining records.");

    // 优雅关闭：尝试发送所有未完成的批次
    while (!forceClose && (accumulator.hasUndrained() || client.hasInFlightRequests())) {
        try {
            runOnce();
        } catch (Exception e) {
            log.error("Uncaught error in kafka producer I/O thread: ", e);
        }
    }

    // 强制关闭处理
    if (forceClose) {
        // 立即断开连接，中断所有正在进行的请求
        client.disconnect();
    }

    log.debug("Shutdown of Kafka producer I/O thread has completed.");
}
```

### 2.2 runOnce() 核心逻辑

```java
void runOnce() {
    if (transactionManager != null) {
        try {
            // 事务处理逻辑
            transactionManager.maybeResolveSequences();

            if (!transactionManager.isTransactional()) {
                // 幂等性生产者且存在未解决的序列号，可能需要重试
            }
        } catch (Exception e) {
            // 事务处理异常
        }
    }

    // 1. 获取准备就绪的节点（有数据可发送且连接可用）
    long currentTimeMs = time.milliseconds();
    RecordAccumulator.ReadyCheckResult result =
        accumulator.ready(metadata.fetch(), currentTimeMs);

    // 2. 检查是否需要更新元数据
    if (!result.unknownLeaderTopics.isEmpty()) {
        // 存在 leader 未知的 topic，请求更新元数据
        metadata.requestUpdate();
    }

    // 3. 处理未准备好的节点（建立连接）
    Iterator<Node> iter = result.readyNodes.iterator();
    long notReadyTimeout = Long.MAX_VALUE;
    while (iter.hasNext()) {
        Node node = iter.next();
        if (!client.ready(node, currentTimeMs)) {
            iter.remove();  // 从就绪列表移除
            notReadyTimeout = Math.min(notReadyTimeout,
                client.pollDelayMs(node, currentTimeMs));
        }
    }

    // 4. 获取待发送的批次（drain）
    Map<Integer, List<ProducerBatch>> batches = accumulator.drain(
        metadata.fetch(), result.readyNodes,
        this.maxRequestSize, currentTimeMs);

    // 5. 为超时的批次创建可运行任务
    List<ProducerBatch> expiredBatches = accumulator.expiredBatches(currentTimeMs);
    this.sensors.recordExpiredBatches(expiredBatches.size());

    // 6. 将超时的批次移动到发送队列
    for (ProducerBatch expiredBatch : expiredBatches) {
        Callback callback = expiredBatch.callbacks().get(0);
        // 触发超时异常回调
    }

    // 7. 合并同分区的多个批次
    batches = accumulator.mutatePartitionState(batches);

    // 8. 计算 poll 超时时间
    long pollTimeout = Math.min(result.nextReadyCheckDelayMs, notReadyTimeout);
    pollTimeout = Math.min(pollTimeout, this.metadataTimeout);

    // 9. 发送请求
    sendProduceRequests(batches, currentTimeMs);

    // 10. 轮询网络事件（处理响应、连接状态等）
    client.poll(pollTimeout, currentTimeMs);
}
```

---

## 3. 发送流程分析

### 3.1 ready() - 确定可发送的节点

```java
// RecordAccumulator.ready() - 检查哪些节点准备好接收数据
public ReadyCheckResult ready(Cluster cluster, long nowMs) {
    Set<Node> readyNodes = new HashSet<>();
    long nextReadyCheckDelayMs = Long.MAX_VALUE;
    Set<String> unknownLeaderTopics = new HashSet<>();

    // 遍历所有分区批次
    for (Map.Entry<TopicPartition, Deque<ProducerBatch>> entry : batches.entrySet()) {
        TopicPartition part = entry.getKey();
        Deque<ProducerBatch> deque = entry.getValue();

        // 获取分区 leader
        Node leader = cluster.leaderFor(part);

        if (leader == null) {
            // Leader 未知，需要更新元数据
            unknownLeaderTopics.add(part.topic());
        } else if (!readyNodes.contains(leader) && !muted.contains(part)) {
            // 检查该分区的批次是否准备好发送
            synchronized (deque) {
                ProducerBatch batch = deque.peekFirst();
                if (batch != null) {
                    long waitedTimeMs = batch.waitedTimeMs(nowMs);
                    boolean backingOff = batch.attempts() > 0 &&
                        waitedTimeMs < retryBackoffMs;
                    long timeToWaitMs = backingOff ? retryBackoffMs : lingerMs;
                    boolean full = deque.size() > 1 || batch.isFull();
                    boolean expired = waitedTimeMs >= timeToWaitMs;
                    boolean sendable = full || expired ||
                        accumulator.isClosed() || flushInProgress();

                    if (sendable && !backingOff) {
                        readyNodes.add(leader);
                    } else {
                        // 计算下次检查时间
                        long timeLeftMs = Math.max(timeToWaitMs - waitedTimeMs, 0);
                        nextReadyCheckDelayMs = Math.min(timeLeftMs, nextReadyCheckDelayMs);
                    }
                }
            }
        }
    }

    return new ReadyCheckResult(readyNodes, nextReadyCheckDelayMs, unknownLeaderTopics);
}
```

**批次发送条件**：

| 条件 | 说明 |
|-----|------|
| `full` | 批次已满（大小达到 batch.size）或有多个批次 |
| `expired` | 等待时间超过 linger.ms（或重试退避时间） |
| `accumulator.isClosed()` | 生产者正在关闭 |
| `flushInProgress()` | 用户调用了 flush() |

### 3.2 drain() - 获取待发送的批次

```java
// 从每个节点获取待发送的批次
public Map<Integer, List<ProducerBatch>> drain(Cluster cluster,
                                                Set<Node> nodes,
                                                int maxSize,
                                                long now) {
    if (nodes.isEmpty())
        return Collections.emptyMap();

    Map<Integer, List<ProducerBatch>> batches = new HashMap<>();

    // 遍历所有准备就绪的节点
    for (Node node : nodes) {
        List<ProducerBatch> ready = new ArrayList<>();
        int size = 0;

        // 获取该节点的所有分区
        List<PartitionInfo> parts = cluster.partitionsForNode(node.id());

        // 遍历分区的批次
        for (PartitionInfo part : parts) {
            TopicPartition tp = new TopicPartition(part.topic(), part.partition());
            if (!muted.contains(tp)) {
                Deque<ProducerBatch> deque = getDeque(tp);
                if (deque != null) {
                    synchronized (deque) {
                        ProducerBatch batch = deque.peekFirst();
                        if (batch != null && !backingOff) {
                            if (size + batch.estimatedSizeInBytes() > maxSize && !ready.isEmpty()) {
                                // 达到单请求大小限制，停止添加
                                break;
                            }
                            batch.close();  // 关闭批次，不再接收新消息
                            ready.add(batch);
                            size += batch.estimatedSizeInBytes();
                        }
                    }
                }
            }
        }
        batches.put(node.id(), ready);
    }

    return batches;
}
```

### 3.3 createProduceRequests() - 构建请求

```java
// 将批次转换为 Produce 请求
private void sendProduceRequests(Map<Integer, List<ProducerBatch>> collated,
                                  long now) {
    for (Map.Entry<Integer, List<ProducerBatch>> entry : collated.entrySet()) {
        int targetNode = entry.getKey();
        List<ProducerBatch> batches = entry.getValue();

        if (batches.isEmpty())
            continue;

        // 将批次转换为分区 -> 记录的形式
        Map<TopicPartition, MemoryRecords> produceRecordsByPartition =
            new HashMap<>(batches.size());

        for (ProducerBatch batch : batches) {
            TopicPartition tp = batch.topicPartition;
            MemoryRecords records = batch.records();
            produceRecordsByPartition.put(tp, records);
        }

        // 创建 Produce 请求
        ProduceRequest.Builder requestBuilder = ProduceRequest.Builder
            .forCurrentMagic(...)  // 使用当前消息格式版本
            .setAcks(acks)          // 确认级别
            .setTimeout(requestTimeoutMs)  // 请求超时时间
            .setTransactionalId(transactionalId)
            .setProducerId(producerId)
            .setProducerEpoch(producerEpoch)
            .setPartitionRecords(produceRecordsByPartition);

        // 创建请求回调
        RequestCompletionHandler callback = new RequestCompletionHandler() {
            @Override
            public void onComplete(ClientResponse response) {
                handleProduceResponse(response, batches, now);
            }
        };

        // 发送请求
        String nodeId = Integer.toString(targetNode);
        ClientRequest clientRequest = client.newClientRequest(
            nodeId, requestBuilder, now, true, callback);
        client.send(clientRequest, now);
    }
}
```

---

## 4. 响应处理流程

### 4.1 成功响应处理

```java
private void handleProduceResponse(ClientResponse response,
                                    List<ProducerBatch> batches,
                                    long now) {
    if (response.wasDisconnected()) {
        // 连接断开，所有批次标记为失败，触发重试
        for (ProducerBatch batch : batches) {
            completeBatch(batch, new ProduceResponse.PartitionResponse(
                Errors.NETWORK_EXCEPTION, ...));
        }
        return;
    }

    ProduceResponse produceResponse = (ProduceResponse) response.responseBody();

    for (ProducerBatch batch : batches) {
        TopicPartition tp = batch.topicPartition;
        ProduceResponse.PartitionResponse partResponse =
            produceResponse.responses().get(tp);

        if (partResponse != null) {
            completeBatch(batch, partResponse);
        }
    }
}

private void completeBatch(ProducerBatch batch,
                           ProduceResponse.PartitionResponse response) {
    Errors error = response.error;

    if (error == Errors.NONE) {
        // 发送成功
        if (transactionManager != null) {
            // 更新事务状态
            transactionManager.handleCompletedBatch(batch, response);
        }

        // 更新元数据（如果需要）
        if (response.logStartOffset >= 0) {
            metadata.updateLogStartOffset(batch.topicPartition, response.logStartOffset);
        }

        // 完成批次，触发回调
        batch.done(response.baseOffset, response.logAppendTime, null);

        // 减少未完成批次计数
        accumulator.deallocate(batch);
        this.sensors.recordBytesSent(batch.estimatedSizeInBytes());

    } else {
        // 处理错误
        handleError(batch, response, error);
    }
}
```

### 4.2 失败响应处理

```java
private void handleError(ProducerBatch batch,
                         ProduceResponse.PartitionResponse response,
                         Errors error) {
    // 判断是否可以重试
    boolean canRetry = canRetry(batch, error);

    if (canRetry && !batch.hasReachedDeliveryTimeout(currentTimeMs)) {
        // 可以重试，重新入队
        batch.requeue();
        this.sensors.recordRetries(batch.topicPartition.topic(), 1);
    } else {
        // 不能重试或已超时，标记为失败
        final RuntimeException exception;
        if (error == Errors.TOPIC_AUTHORIZATION_FAILED) {
            exception = new TopicAuthorizationException(batch.topicPartition.topic());
        } else if (error == Errors.TRANSACTIONAL_ID_AUTHORIZATION_FAILED) {
            exception = new TransactionalIdAuthorizationException();
        } else {
            exception = error.exception(...);
        }

        // 标记失败，触发回调
        batch.done(response.baseOffset, response.logAppendTime, exception);
        accumulator.deallocate(batch);
        this.sensors.recordErrors(batch.topicPartition.topic(), 1);
    }
}
```

### 4.3 可重试错误判断

```java
private boolean canRetry(ProducerBatch batch, Errors error) {
    // 1. 检查错误类型是否可重试
    if (!error.isRetriable()) {
        return false;
    }

    // 2. 检查是否还有重试次数
    if (batch.attempts() >= retries) {
        return false;
    }

    // 3. 检查事务状态
    if (transactionManager != null) {
        // 如果存在 fatal error，不能再重试
        if (transactionManager.hasFatalError()) {
            return false;
        }
        // 如果正在中止事务，只能中止不能发送
        if (transactionManager.isAborting()) {
            return false;
        }
    }

    return true;
}
```

**可重试错误类型**：

| 错误 | 说明 |
|-----|------|
| `NOT_LEADER_OR_FOLLOWER` | Leader 变更，需要重试 |
| `UNKNOWN_TOPIC_OR_PARTITION` | 元数据过期，需要更新后重试 |
| `LEADER_NOT_AVAILABLE` | Leader 不可用，需要重试 |
| `BROKER_NOT_AVAILABLE` | Broker 不可用，需要重试 |
| `REQUEST_TIMED_OUT` | 请求超时 |
| `NETWORK_EXCEPTION` | 网络异常 |

---

## 5. 重试机制

### 5.1 重试流程

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   发送批次   │────▶│  接收响应    │────▶│  判断结果    │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┼──────────┐
                    │                          │          │
                    ▼                          ▼          ▼
              ┌─────────┐              ┌──────────┐  ┌────────┐
              │  成功   │              │  可重试  │  │  失败  │
              │ done()  │              │ requeue()│  │ done() │
              └─────────┘              └────┬─────┘  └────────┘
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ 等待退避时间   │
                                    │ retryBackoffMs│
                                    └───────┬───────┘
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │  重新发送      │
                                    │ attempts++    │
                                    └───────────────┘
```

### 5.2 重试退避策略

```java
// 重试退避时间（默认 100ms）
private final long retryBackoffMs;

// 在 ready() 中判断是否在退避期
boolean backingOff = batch.attempts() > 0 &&
                     batch.waitedTimeMs(nowMs) < retryBackoffMs;

// 如果在退避期，使用 retryBackoffMs 作为等待时间
long timeToWaitMs = backingOff ? retryBackoffMs : lingerMs;
```

### 5.3 防止消息乱序

```java
// max.in.flight.requests.per.connection 控制单连接并发请求数
private final int maxInFlightRequestsPerConnection;
```

**幂等性生产者的顺序保证**：

```
max.in.flight.requests.per.connection = 5

发送顺序:  [1] [2] [3] [4] [5]
           │   │   │   │   │
           ▼   ▼   ▼   ▼   ▼
         ┌───┬───┬───┬───┬───┐
         │ 1 │ 2 │ 3 │ 4 │ 5 │  <-- 最多 5 个并发请求
         └───┴───┴───┴───┴───┘
           │   │   │   │   │
           ▼   ▼   ▼   ▼   ▼
         响应顺序: [1] [2] [3] [4] [5]

如果 batch 2 失败重试:
- 幂等性生产者: 暂停发送 batch 3-5，先发送 batch 2
- 非幂等性生产者: 直接发送 batch 3-5，可能乱序
```

---

## 6. 性能优化

### 6.1 发送参数调优

```java
// 1. 增加单请求最大大小（默认 1MB）
props.put("max.request.size", 5 * 1024 * 1024);  // 5MB

// 2. 增加单连接并发请求数（默认 5）
props.put("max.in.flight.requests.per.connection", 10);

// 3. 请求超时时间（默认 30s）
props.put("request.timeout.ms", 60000);  // 60s

// 4. 重试次数（默认 0）
props.put("retries", Integer.MAX_VALUE);

// 5. 重试退避时间（默认 100ms）
props.put("retry.backoff.ms", 1000);  // 1s
```

### 6.2 网络参数调优

```java
// TCP 发送缓冲区（默认 128KB）
props.put("send.buffer.bytes", 256 * 1024);  // 256KB

// TCP 接收缓冲区（默认 64KB）
props.put("receive.buffer.bytes", 128 * 1024);  // 128KB

// 连接空闲超时（默认 9分钟）
props.put("connections.max.idle.ms", 540000);
```

### 6.3 关键监控指标

| 指标名 | 类型 | 说明 | 优化建议 |
|-------|------|------|---------|
| `io-wait-ratio` | Avg | I/O 等待时间比例 | < 0.3 表示 Sender 忙碌 |
| `outgoing-byte-rate` | Rate | 发送字节速率 | 与预期吞吐对比 |
| `request-rate` | Rate | 请求发送速率 | 过低可能需要调优 linger.ms |
| `request-latency-avg` | Avg | 请求平均延迟 | 过高检查网络或 Broker |
| `record-retry-rate` | Rate | 重试速率 | < 1% 为健康 |
| `record-error-rate` | Rate | 错误速率 | 应为 0 |

### 6.4 Sender 线程问题排查

**问题 1: 发送延迟高**
```
原因分析：
1. linger.ms 设置过大
2. batch.size 设置过小，批次不满
3. 网络延迟或 Broker 负载高

排查命令：
- 查看 record-queue-time-avg（消息在缓冲区等待时间）
- 查看 request-latency-avg（请求网络延迟）
```

**问题 2: 吞吐不足**
```
原因分析：
1. batch.size 过小
2. buffer.memory 不足，频繁阻塞
3. max.in.flight.requests.per.connection 过低

优化方案：
1. 增加 batch.size 到 32KB+
2. 增加 buffer.memory 到 64MB+
3. 增加 max.in.flight.requests.per.connection 到 10
```

**问题 3: 重试过多**
```
原因分析：
1. 网络不稳定
2. Broker 频繁 Leader 变更
3. request.timeout.ms 过短

优化方案：
1. 增加 request.timeout.ms
2. 增加 retry.backoff.ms 避免频繁重试
3. 检查 Broker 集群稳定性
```

---

**上一章**: [02. RecordAccumulator 缓冲区](./02-record-accumulator.md)
**下一章**: [04. Producer 元数据管理](./04-metadata-management.md)
