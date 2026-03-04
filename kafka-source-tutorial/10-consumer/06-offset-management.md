# 06. Offset 管理策略

本文档深入分析 Kafka Consumer 的 Offset 管理机制，了解消费位移的存储、提交和重置策略。

## 目录
- [1. Offset 概述](#1-offset-概述)
- [2. Offset 存储位置](#2-offset-存储位置)
- [3. 自动提交机制](#3-自动提交机制)
- [4. 手动提交策略](#4-手动提交策略)
- [5. Offset 重置策略](#5-offset-重置策略)
- [6. Offset 提交失败处理](#6-offset-提交失败处理)

---

## 1. Offset 概述

### 1.1 什么是 Offset

Offset 是 Kafka 中消息的唯一标识，表示消息在分区中的位置：

```
分区中的消息布局：

Topic: order-topic, Partition: 0
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ Offset 0│ Offset 1│ Offset 2│ Offset 3│ Offset 4│ Offset 5│
│  msg-1  │  msg-2  │  msg-3  │  msg-4  │  msg-5  │  msg-6  │
│  ✅已消费│  ✅已消费│  ✅已消费│  ⏳当前  │  ⏳未消费│  ⏳未消费│
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
                           ↑
                    Current Position = 3
                    （下一条要消费的消息）

Consumer 需要记录：
- 最后消费的 Offset (2)
- 当前位置 Offset (3)
- 已提交的 Offset (2)
```

### 1.2 Offset 的重要性

| 作用 | 说明 |
|-----|------|
| **消费进度追踪** | 记录已消费和未消费的消息位置 |
| **故障恢复** | 重启后从上次位置继续消费 |
| **重复消费控制** | 避免消息重复或丢失 |
| **消费组协调** | 多个 Consumer 协调消费进度 |

### 1.3 OffsetAndMetadata 结构

```java
/**
 * Offset 和元数据封装
 */
public class OffsetAndMetadata {
    private final long offset;                    // 消费位移
    private final Optional<Integer> leaderEpoch;  // Leader Epoch
    private final String metadata;                // 自定义元数据

    public OffsetAndMetadata(long offset, String metadata) {
        this(offset, Optional.empty(), metadata);
    }

    public OffsetAndMetadata(long offset,
                             Optional<Integer> leaderEpoch,
                             String metadata) {
        this.offset = offset;
        this.leaderEpoch = leaderEpoch;
        this.metadata = metadata;
    }

    public long offset() {
        return offset;
    }

    public Optional<Integer> leaderEpoch() {
        return leaderEpoch;
    }

    public String metadata() {
        return metadata;
    }
}
```

**Leader Epoch 的作用**：
- 防止因 Leader 变更导致的数据不一致
- 确保 Consumer 从正确的 Leader 读取数据

---

## 2. Offset 存储位置

### 2.1 __consumer_offsets Topic

Kafka 将消费组的 Offset 存储在一个特殊的内部 Topic 中：

```
__consumer_offsets Topic 结构：

分区数：默认 50（可通过 offsets.topic.num.partitions 配置）
副本因子：默认 3（可通过 offsets.topic.replication.factor 配置）

消息格式：
Key: [groupId, topic, partition]
Value: {
    "offset": 100,
    "metadata": "",
    "commitTimestamp": 1234567890,
    "expireTimestamp": -1
}
```

**Offset 存储流程**：

```java
/**
 * GroupCoordinator 处理 OffsetCommit 请求
 */
public void handleOffsetCommit(OffsetCommitRequest request) {
    String groupId = request.groupId();

    // 1. 验证消费组成员身份
    GroupMetadata group = groupManager.getGroup(groupId);
    if (!group.hasMember(request.memberId())) {
        return error(UNKNOWN_MEMBER_ID);
    }

    // 2. 验证 Generation
    if (group.generationId() != request.generationId()) {
        return error(ILLEGAL_GENERATION);
    }

    // 3. 将 Offset 写入 __consumer_offsets
    for (OffsetCommitRequestData.OffsetCommitRequestTopic topic : request.topics()) {
        for (OffsetCommitRequestData.OffsetCommitRequestPartition partition : topic.partitions()) {
            // 计算存储分区
            int offsetPartition = Utils.abs(groupId.hashCode()) % offsetTopicPartitionCount;

            // 构建消息
            OffsetKey key = new OffsetKey(groupId, topic.name(), partition.partitionIndex());
            OffsetValue value = new OffsetValue(
                partition.committedOffset(),
                partition.committedMetadata(),
                System.currentTimeMillis()
            );

            // 追加到 __consumer_offsets
            appendToLog(offsetPartition, key, value);
        }
    }

    return success();
}
```

### 2.2 GroupCoordinator 存储

```java
/**
 * GroupCoordinator 内存中的 Offset 缓存
 */
public class GroupMetadata {
    // 消费组 ID
    private final String groupId;

    // 成员列表
    private final Map<String, MemberMetadata> members;

    // 提交的 Offset（内存缓存）
    private final Map<TopicPartition, CommitRecord> offsets;

    /**
     * 提交 Offset
     */
    public void commitOffset(TopicPartition tp, long offset, String metadata) {
        offsets.put(tp, new CommitRecord(offset, metadata, System.currentTimeMillis()));
    }

    /**
     * 获取已提交的 Offset
     */
    public OffsetAndMetadata fetchOffset(TopicPartition tp) {
        CommitRecord record = offsets.get(tp);
        if (record != null) {
            return new OffsetAndMetadata(record.offset, record.metadata);
        }
        return null;
    }
}
```

### 2.3 ZooKeeper (已弃用)

```java
/**
 * 旧版 Offset 存储（Kafka < 0.9）
 *
 * 存储路径: /consumers/{groupId}/offsets/{topic}/{partition}
 * 存储值: offset 数值
 *
 * 已弃用原因：
 * 1. ZooKeeper 不适合高频写入
 * 2. 写入延迟高
 * 3. 可靠性不如 Kafka Topic
 */
```

---

## 3. 自动提交机制

### 3.1 enable.auto.commit 配置

```java
/**
 * 自动提交配置
 */
// 启用自动提交（默认 true）
props.put("enable.auto.commit", "true");

// 自动提交间隔（默认 5 秒）
props.put("auto.commit.interval.ms", "5000");

/**
 * 自动提交的实现
 */
public class ConsumerCoordinator {
    private final boolean autoCommitEnabled;
    private final int autoCommitIntervalMs;
    private long nextAutoCommitDeadline;

    /**
     * 检查是否需要自动提交
     */
    private void maybeAutoCommitOffsetsAsync(long now) {
        if (!autoCommitEnabled) {
            return;
        }

        if (now >= nextAutoCommitDeadline) {
            // 构建待提交的 Offsets
            Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
            for (TopicPartition tp : subscriptions.assignedPartitions()) {
                Long position = subscriptions.position(tp);
                if (position != null) {
                    offsets.put(tp, new OffsetAndMetadata(position));
                }
            }

            // 异步提交（不阻塞消费）
            commitAsync(offsets, (committedOffsets, exception) -> {
                if (exception != null) {
                    log.warn("Auto offset commit failed", exception);
                }
            });

            nextAutoCommitDeadline = now + autoCommitIntervalMs;
        }
    }
}
```

### 3.2 auto.commit.interval.ms

```java
/**
 * 自动提交间隔调优
 */

// 高频提交（低延迟，高可靠性）
props.put("auto.commit.interval.ms", "1000");  // 1 秒
// 优点：故障时丢失消息少
// 缺点：增加网络和存储开销

// 低频提交（高吞吐，低可靠性）
props.put("auto.commit.interval.ms", "30000");  // 30 秒
// 优点：减少提交开销
// 缺点：故障时可能重复消费大量消息
```

### 3.3 自动提交的实现原理

```
自动提交时机：

1. poll() 调用时检查
   ┌─────────────────────────────────────────────┐
   │ consumer.poll(Duration.ofMillis(100))       │
   │                                             │
   │ 1. 检查 auto.commit.interval.ms 是否到期    │
   │ 2. 如果到期，触发异步提交                   │
   │ 3. 继续执行 poll 逻辑                       │
   └─────────────────────────────────────────────┘

2. 订阅状态变化时
   - subscribe() 调用
   - unsubscribe() 调用

3. Consumer 关闭时
   - close() 方法中同步提交
```

### 3.4 自动提交的风险

```java
/**
 * 自动提交的风险示例
 */
public void autoCommitRiskDemo() {
    props.put("enable.auto.commit", "true");
    props.put("auto.commit.interval.ms", "5000");

    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
    consumer.subscribe(Arrays.asList("topic"));

    while (true) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));

        for (ConsumerRecord<String, String> record : records) {
            // 处理消息
            process(record);

            /**
             * 风险场景：
             * 1. 处理第 100 条消息时崩溃
             * 2. 自动提交已提交到第 95 条
             * 3. 重启后从 96 条开始消费
             * 4. 96-100 条消息已处理但未提交
             * 5. 导致重复消费
             */
        }
    }
}
```

---

## 4. 手动提交策略

### 4.1 commitSync() 同步提交

```java
/**
 * 同步提交 - 阻塞直到提交成功或超时
 */
public void commitSyncExample() {
    props.put("enable.auto.commit", "false");

    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
    consumer.subscribe(Arrays.asList("topic"));

    try {
        while (true) {
            ConsumerRecords<String, String> records =
                consumer.poll(Duration.ofMillis(100));

            for (ConsumerRecord<String, String> record : records) {
                try {
                    process(record);
                } catch (Exception e) {
                    // 处理失败，跳过或重试
                    log.error("Process failed", e);
                    // 选择 1: 跳过，继续处理下一条
                    continue;
                    // 选择 2: 重试
                    // retryProcess(record);
                }
            }

            try {
                // 同步提交 - 阻塞直到提交成功
                consumer.commitSync();
                log.debug("Offset committed successfully");
            } catch (CommitFailedException e) {
                // 提交失败，重新消费
                log.error("Commit failed", e);
            }
        }
    } finally {
        consumer.close();
    }
}

/**
 * 带超时的同步提交
 */
public void commitSyncWithTimeout() {
    try {
        consumer.commitSync(Duration.ofSeconds(5));
    } catch (TimeoutException e) {
        log.error("Commit timeout", e);
    } catch (CommitFailedException e) {
        log.error("Commit failed", e);
    }
}
```

### 4.2 commitAsync() 异步提交

```java
/**
 * 异步提交 - 不阻塞消费流程
 */
public void commitAsyncExample() {
    props.put("enable.auto.commit", "false");

    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
    consumer.subscribe(Arrays.asList("topic"));

    final int commitBatchSize = 100;
    int messageCount = 0;

    while (true) {
        ConsumerRecords<String, String> records =
            consumer.poll(Duration.ofMillis(100));

        for (ConsumerRecord<String, String> record : records) {
            process(record);
            messageCount++;
        }

        // 批量异步提交
        if (messageCount >= commitBatchSize) {
            consumer.commitAsync((offsets, exception) -> {
                if (exception != null) {
                    log.error("Commit failed for offsets: {}", offsets, exception);
                    // 异步提交失败不会重试，需要自行处理
                } else {
                    log.debug("Offset committed: {}", offsets);
                }
            });
            messageCount = 0;
        }
    }
}

/**
 * 异步提交失败重试
 */
private final AtomicReference<Exception> lastError = new AtomicReference<>();

public void commitAsyncWithRetry() {
    consumer.commitAsync((offsets, exception) -> {
        if (exception != null) {
            lastError.set(exception);
            log.error("Commit failed, will retry", exception);

            // 在下次 poll 前重试同步提交
            try {
                consumer.commitSync();
                lastError.set(null);
            } catch (Exception e) {
                log.error("Retry commit also failed", e);
            }
        }
    });
}
```

### 4.3 特定分区提交

```java
/**
 * 按分区提交 - 精细化控制
 */
public void commitPerPartition() {
    Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();

    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));

    // 按分区处理
    for (TopicPartition partition : records.partitions()) {
        List<ConsumerRecord<String, String>> partitionRecords =
            records.records(partition);

        long lastOffset = -1;
        for (ConsumerRecord<String, String> record : partitionRecords) {
            process(record);
            lastOffset = record.offset();
        }

        // 记录每个分区的最后 Offset
        if (lastOffset >= 0) {
            offsets.put(partition, new OffsetAndMetadata(lastOffset + 1));
        }
    }

    // 批量提交所有分区的 Offset
    if (!offsets.isEmpty()) {
        consumer.commitSync(offsets);
    }
}

/**
 * 精细化控制：按消息提交
 */
public void commitPerMessage() {
    while (true) {
        ConsumerRecords<String, String> records =
            consumer.poll(Duration.ofMillis(100));

        for (ConsumerRecord<String, String> record : records) {
            boolean success = processWithRetry(record);

            if (success) {
                // 单条消息提交
                TopicPartition tp = new TopicPartition(
                    record.topic(),
                    record.partition()
                );
                OffsetAndMetadata offset = new OffsetAndMetadata(
                    record.offset() + 1
                );

                consumer.commitSync(Collections.singletonMap(tp, offset));
            } else {
                // 处理失败，不提交 Offset
                // 下次会重新消费这条消息
                log.error("Failed to process record: {}", record);
                break;  // 退出循环，下次重试
            }
        }
    }
}
```

### 4.4 批量提交优化

```java
/**
 * 批量提交策略
 */
public class BatchCommitStrategy {

    private final KafkaConsumer<String, String> consumer;
    private final int batchSize;
    private final long commitIntervalMs;

    private final Map<TopicPartition, Long> pendingOffsets = new HashMap<>();
    private long lastCommitTime = System.currentTimeMillis();

    public void processRecords(ConsumerRecords<String, String> records) {
        for (ConsumerRecord<String, String> record : records) {
            process(record);

            // 记录待提交的 Offset
            TopicPartition tp = new TopicPartition(
                record.topic(),
                record.partition()
            );
            pendingOffsets.put(tp, record.offset() + 1);
        }

        // 检查是否需要提交
        if (shouldCommit()) {
            commitPendingOffsets();
        }
    }

    private boolean shouldCommit() {
        // 条件 1: 达到批量大小
        if (pendingOffsets.size() >= batchSize) {
            return true;
        }

        // 条件 2: 达到提交间隔
        long now = System.currentTimeMillis();
        if (now - lastCommitTime >= commitIntervalMs) {
            return true;
        }

        return false;
    }

    private void commitPendingOffsets() {
        if (pendingOffsets.isEmpty()) {
            return;
        }

        Map<TopicPartition, OffsetAndMetadata> offsets =
            pendingOffsets.entrySet().stream()
                .collect(Collectors.toMap(
                    Map.Entry::getKey,
                    e -> new OffsetAndMetadata(e.getValue())
                ));

        try {
            consumer.commitSync(offsets);
            pendingOffsets.clear();
            lastCommitTime = System.currentTimeMillis();
        } catch (Exception e) {
            log.error("Batch commit failed", e);
            // 保留 pendingOffsets，下次重试
        }
    }
}
```

---

## 5. Offset 重置策略

### 5.1 earliest 策略

```java
/**
 * earliest - 从最早的可用 Offset 开始消费
 */
props.put("auto.offset.reset", "earliest");

/**
 * 适用场景：
 * 1. 首次部署 Consumer，需要处理历史数据
 * 2. 数据不能丢失，需要回溯消费
 * 3. 数据保留期内的全量处理
 */

// 消费流程
// 1. Consumer 启动，无已提交 Offset
// 2. 查询最早的 Offset（log start offset）
// 3. 从最早位置开始消费
// 4. 消费完所有历史消息后消费新消息

// 注意事项：
// - 如果数据保留时间长，可能需要处理大量历史数据
// - 确保 Consumer 处理能力足够
// - 考虑设置合理的 max.poll.records
```

### 5.2 latest 策略

```java
/**
 * latest - 从最新的 Offset 开始消费（默认）
 */
props.put("auto.offset.reset", "latest");

/**
 * 适用场景：
 * 1. 只关心新产生的数据
 * 2. 实时数据处理
 * 3. 不需要处理历史数据
 */

// 消费流程
// 1. Consumer 启动，无已提交 Offset
// 2. 查询最新的 Offset（high watermark）
// 3. 从最新位置开始消费
// 4. 只消费启动后新产生的消息

// 注意事项：
// - 会跳过历史消息
// - 适用于实时场景
// - 如果需要历史数据，改用 earliest
```

### 5.3 none 策略

```java
/**
 * none - 无初始 Offset 时抛出异常
 */
props.put("auto.offset.reset", "none");

/**
 * 适用场景：
 * 1. 严格的消费组管理
 * 2. 需要显式指定消费位置
 * 3. 避免意外消费
 */

// 行为：
// - 如果有已提交的 Offset，正常消费
// - 如果无已提交的 Offset，抛出 NoOffsetForPartitionException

// 使用示例
public void strictOffsetManagement() {
    props.put("auto.offset.reset", "none");

    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);

    try {
        consumer.subscribe(Arrays.asList("topic"));
        consumer.poll(Duration.ofMillis(100));
    } catch (NoOffsetForPartitionException e) {
        // 处理无 Offset 的情况
        log.error("No committed offset found for partition: {}", e.partition());

        // 选择 1: 手动设置起始位置
        consumer.seek(e.partition(), 0);

        // 选择 2: 抛出异常，人工介入
        throw new RuntimeException("Please set initial offset manually", e);
    }
}
```

### 5.4 自定义重置逻辑

```java
/**
 * 手动设置消费位置
 */
public void customOffsetReset() {
    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
    consumer.subscribe(Arrays.asList("topic"));

    // 等待分配分区
    Set<TopicPartition> assignment = Collections.emptySet();
    while (assignment.isEmpty()) {
        consumer.poll(Duration.ofMillis(100));
        assignment = consumer.assignment();
    }

    // 自定义重置逻辑
    for (TopicPartition tp : assignment) {
        // 获取已提交的 Offset
        OffsetAndMetadata committed = consumer.committed(tp);

        if (committed == null) {
            // 无提交记录，自定义起始位置

            // 选项 1: 从特定时间开始
            Map<TopicPartition, Long> timestamps = new HashMap<>();
            timestamps.put(tp, System.currentTimeMillis() - 24 * 60 * 60 * 1000); // 一天前
            Map<TopicPartition, OffsetAndTimestamp> offsets =
                consumer.offsetsForTimes(timestamps);
            consumer.seek(tp, offsets.get(tp).offset());

            // 选项 2: 从特定 Offset 开始
            consumer.seek(tp, 1000);

            // 选项 3: 从最早开始
            consumer.seekToBeginning(Collections.singletonList(tp));

            // 选项 4: 从最新开始
            consumer.seekToEnd(Collections.singletonList(tp));
        }
    }
}

/**
 * 基于时间的 Offset 查找
 */
public void seekByTime() {
    // 查找 2 小时前的 Offset
    long oneHourAgo = System.currentTimeMillis() - (2 * 60 * 60 * 1000);

    Map<TopicPartition, Long> timestampsToSearch = consumer.assignment().stream()
        .collect(Collectors.toMap(
            tp -> tp,
            tp -> oneHourAgo
        ));

    Map<TopicPartition, OffsetAndTimestamp> offsets =
        consumer.offsetsForTimes(timestampsToSearch);

    for (TopicPartition tp : offsets.keySet()) {
        OffsetAndTimestamp offsetAndTimestamp = offsets.get(tp);
        if (offsetAndTimestamp != null) {
            consumer.seek(tp, offsetAndTimestamp.offset());
        }
    }
}
```

---

## 6. Offset 提交失败处理

### 6.1 失败类型分类

```java
/**
 * Offset 提交失败类型
 */
public enum CommitErrorType {
    // 可重试错误
    COORDINATOR_NOT_AVAILABLE,   // Coordinator 不可用，临时错误
    COORDINATOR_LOAD_IN_PROGRESS,// Coordinator 正在加载
    NOT_COORDINATOR,             // 不是 Coordinator
    REQUEST_TIMED_OUT,           // 请求超时

    // 不可重试错误
    UNKNOWN_TOPIC_OR_PARTITION,  // 未知分区
    TOPIC_AUTHORIZATION_FAILED,  // 权限不足
    GROUP_AUTHORIZATION_FAILED,  // 消费组权限不足

    // 需要重新加入消费组
    REBALANCE_IN_PROGRESS,       // 正在重平衡
    ILLEGAL_GENERATION,          // 世代号过期
    UNKNOWN_MEMBER_ID,           // 成员 ID 未知
}
```

### 6.2 重试机制

```java
/**
 * 带重试的 Offset 提交
 */
public void commitWithRetry() {
    int maxRetries = 3;
    int retryIntervalMs = 1000;

    for (int attempt = 0; attempt < maxRetries; attempt++) {
        try {
            consumer.commitSync();
            log.debug("Commit succeeded on attempt {}", attempt + 1);
            return;
        } catch (RetriableCommitFailedException e) {
            // 可重试错误
            if (attempt < maxRetries - 1) {
                log.warn("Commit failed (attempt {}), retrying...", attempt + 1);
                try {
                    Thread.sleep(retryIntervalMs * (attempt + 1)); // 指数退避
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            } else {
                log.error("Commit failed after {} attempts", maxRetries, e);
                throw e;
            }
        } catch (CommitFailedException e) {
            // 不可重试错误
            log.error("Commit failed with non-retriable error", e);
            handleNonRetriableCommitError(e);
            return;
        }
    }
}
```

### 6.3 死信队列策略

```java
/**
 * 处理提交失败的消息
 */
public class DeadLetterQueueHandler {

    private final KafkaProducer<String, String> dlqProducer;
    private final String dlqTopic;

    public void processWithDLQ(ConsumerRecords<String, String> records) {
        for (ConsumerRecord<String, String> record : records) {
            try {
                process(record);
            } catch (Exception e) {
                // 处理失败，发送到死信队列
                sendToDLQ(record, e);
            }
        }

        try {
            consumer.commitSync();
        } catch (Exception e) {
            // 提交失败，不发送 DLQ，记录日志
            log.error("Commit failed, will retry processing", e);
            // 下次 poll 会重新消费这批消息
        }
    }

    private void sendToDLQ(ConsumerRecord<String, String> record, Exception error) {
        ProducerRecord<String, String> dlqRecord = new ProducerRecord<>(
            dlqTopic,
            record.key(),
            record.value()
        );

        // 添加元数据到 Header
        dlqRecord.headers()
            .add("original-topic", record.topic().getBytes())
            .add("original-partition", String.valueOf(record.partition()).getBytes())
            .add("original-offset", String.valueOf(record.offset()).getBytes())
            .add("error-message", error.getMessage().getBytes())
            .add("error-timestamp", String.valueOf(System.currentTimeMillis()).getBytes());

        dlqProducer.send(dlqRecord);
    }
}
```

### 6.4 监控告警

```java
/**
 * Offset 提交监控
 */
public class OffsetCommitMonitor {

    private final MeterRegistry meterRegistry;

    public void recordCommitResult(boolean success, long latencyMs) {
        // 记录提交成功率
        meterRegistry.counter("kafka.consumer.commit.total",
            "status", success ? "success" : "failure").increment();

        // 记录提交延迟
        meterRegistry.timer("kafka.consumer.commit.latency")
            .record(latencyMs, TimeUnit.MILLISECONDS);
    }

    public void recordLag(Map<TopicPartition, Long> consumerPositions,
                          Map<TopicPartition, Long> endOffsets) {
        for (TopicPartition tp : consumerPositions.keySet()) {
            long position = consumerPositions.get(tp);
            long endOffset = endOffsets.getOrDefault(tp, position);
            long lag = endOffset - position;

            // 记录消费延迟
            meterRegistry.gauge("kafka.consumer.lag",
                Tags.of("topic", tp.topic(), "partition", String.valueOf(tp.partition())),
                lag);
        }
    }

    /**
     * 告警规则
     */
    public void checkAlertConditions() {
        // 告警 1: 提交失败率过高
        double failureRate = calculateFailureRate();
        if (failureRate > 0.1) {  // 10% 失败率
            alert("High offset commit failure rate: " + failureRate);
        }

        // 告警 2: 消费延迟过高
        long maxLag = getMaxLag();
        if (maxLag > 10000) {  // 10000 条消息延迟
            alert("High consumer lag: " + maxLag);
        }

        // 告警 3: 提交延迟过高
        double avgCommitLatency = getAvgCommitLatency();
        if (avgCommitLatency > 5000) {  // 5 秒
            alert("High commit latency: " + avgCommitLatency + "ms");
        }
    }
}
```

---

**上一章**: [05. Consumer Rebalance 重平衡详解](./05-rebalance-process.md)
**下一章**: [07. 新版 AsyncKafkaConsumer 详解](./07-new-consumer.md)
