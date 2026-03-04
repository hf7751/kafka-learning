# 07. TransactionManager 事务管理器

本文档深入分析 Kafka Producer 的事务管理器实现，了解如何实现幂等性和事务语义。

## 目录
- [1. 事务管理概述](#1-事务管理概述)
- [2. TransactionManager 结构](#2-transactionmanager-结构)
- [3. 事务状态机](#3-事务状态机)
- [4. 事务操作流程](#4-事务操作流程)
- [5. 幂等性实现](#5-幂等性实现)
- [6. 事务超时与恢复](#6-事务超时与恢复)

---

## 1. 事务管理概述

### 1.1 为什么需要事务

| 问题 | 说明 |
|-----|------|
| **消息重复** | 网络重试可能导致消息重复写入 |
| **消息丢失** | 发送失败可能导致消息未写入 |
| **跨分区原子性** | 需要同时发送到多个分区的消息保持一致性 |
| **消费-生产原子性** | Consumer 消费消息后向其他 Topic 发送需要原子性 |

### 1.2 事务语义保证

```
┌─────────────────────────────────────────────────────────────┐
│                     事务语义保证                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 幂等性生产者 (enable.idempotence=true)                   │
│                                                             │
│     ┌─────────┐         ┌─────────┐         ┌─────────┐    │
│     │ 消息 1  │────────▶│  Broker  │────────▶│ 分区 0  │    │
│     │ Seq=0   │         │         │         │         │    │
│     └─────────┘         │         │         ├─────────┤    │
│     ┌─────────┐         │         │         │ 消息 1  │    │
│     │ 消息 2  │────────▶│         │         │ Seq=0   │    │
│     │ Seq=1   │         │         │         ├─────────┤    │
│     └─────────┘         │         │         │ 消息 2  │    │
│                         │         │         │ Seq=1   │    │
│  保证：即使重试，消息也不会重复写入                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  2. 事务生产者 (transactional.id 设置)                       │
│                                                             │
│     beginTransaction()                                      │
│          │                                                  │
│          ▼                                                  │
│     ┌──────────────────────────────────────────────────┐   │
│     │ 事务边界                                         │   │
│     │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │   │
│     │  │ Topic A │  │ Topic B │  │ Topic C │          │   │
│     │  │  Msg 1  │  │  Msg 2  │  │  Msg 3  │          │   │
│     │  └─────────┘  └─────────┘  └─────────┘          │   │
│     └──────────────────────────────────────────────────┘   │
│          │                                                  │
│          ▼                                                  │
│     commitTransaction() / abortTransaction()                │
│                                                             │
│  保证：所有消息要么全部成功，要么全部失败                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 TransactionManager 的职责

```java
/**
 * TransactionManager 核心职责：
 * 1. 维护事务状态
 * 2. 管理 Producer ID 和序列号
 * 3. 处理事务相关的 RPC 请求
 * 4. 协调消费-生产事务
 */
public class TransactionManager {
    // 事务配置
    private final String transactionalId;
    private final int transactionTimeoutMs;
    private final long retryBackoffMs;

    // 事务状态
    private volatile State state;
    private volatile ProducerIdAndEpoch producerIdAndEpoch;

    // 事务中的分区
    private final Set<TopicPartition> partitionsInTransaction;
    private final Set<TopicPartition> pendingPartitionsInTransaction;
    private final Set<TopicPartition> partitionsAdded;

    // 序列号管理
    private final Map<TopicPartition, Integer> sequenceNumbers;
    private final Map<TopicPartition, Integer> lastAckedSequence;

    // 待发送的请求队列
    private final PriorityQueue<TransactionBatch> transactionBatches;
}
```

---

## 2. TransactionManager 结构

### 2.1 核心字段

```java
public class TransactionManager {

    // ============ 配置字段 ============

    // 事务 ID，标识一个事务性生产者实例
    // 用于恢复未完成的事务和实现 fencing
    private final String transactionalId;

    // 事务超时时间（默认 60 秒）
    private final int transactionTimeoutMs;

    // 重试退避时间
    private final long retryBackoffMs;

    // ============ 状态字段 ============

    // 当前事务状态（线程安全）
    private volatile State state;

    // Producer ID 和 Epoch
    // PID：唯一标识生产者实例
    // Epoch：单调递增，用于 fencing 旧生产者
    private volatile ProducerIdAndEpoch producerIdAndEpoch;

    // ============ 事务跟踪字段 ============

    // 当前事务中已发送消息的分区
    private final Set<TopicPartition> partitionsInTransaction;

    // 等待加入事务的分区
    private final Set<TopicPartition> pendingPartitionsInTransaction;

    // 新增的分区（用于发送 TxnOffsetCommit）
    private final Set<TopicPartition> partitionsAdded;

    // 消费者组协调器（用于消费-生产事务）
    private volatile Node consumerGroupCoordinator;

    // ============ 幂等性字段 ============

    // 每个分区的下一个序列号
    private final Map<TopicPartition, Integer> sequenceNumbers;

    // 每个分区最后确认的序列号
    private final Map<TopicPartition, Integer> lastAckedSequence;

    // 每个分区正在发送的批次（用于处理乱序确认）
    private final Map<TopicPartition, List<ProducerBatch>> inflightBatchesByPartition;
}
```

### 2.2 状态管理

```java
/**
 * 事务状态枚举
 */
public enum State {
    UNINITIALIZED,      // 未初始化
    INITIALIZING,       // 正在初始化（获取 PID）
    READY,              // 准备就绪，可以开始事务
    IN_TRANSACTION,     // 事务进行中
    COMMITTING_TRANSACTION,     // 正在提交事务
    ABORTING_TRANSACTION,       // 正在中止事务
    ABORTABLE_ERROR,    // 可中止的错误状态
    FATAL_ERROR,        // 致命错误，生产者必须关闭
}
```

### 2.3 请求队列

```java
/**
 * 事务请求队列管理
 */
private final PriorityQueue<TransactionBatch> pendingBatches;

/**
 * 事务批次的排序依据
 */
class TransactionBatch implements Comparable<TransactionBatch> {
    final long baseSequence;
    final ProducerBatch batch;

    @Override
    public int compareTo(TransactionBatch other) {
        // 按序列号排序，确保按顺序发送
        return Long.compare(this.baseSequence, other.baseSequence);
    }
}
```

---

## 3. 事务状态机

### 3.1 事务状态定义

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          事务状态转换图                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐                                                        │
│  │ UNINITIALIZED│                                                       │
│  └──────┬──────┘                                                       │
│         │ initTransactions()                                           │
│         ▼                                                              │
│  ┌─────────────┐     获取 PID 成功      ┌─────────┐                    │
│  │ INITIALIZING │──────────────────────▶│  READY  │                    │
│  └─────────────┘                       └────┬────┘                    │
│                                             │                          │
│                         beginTransaction() │                          │
│                                             ▼                          │
│                                     ┌──────────────┐                   │
│                                     │ IN_TRANSACTION│                  │
│                                     └──────┬───────┘                   │
│                                            │                           │
│         ┌──────────────────────────────────┼──────────────────┐       │
│         │                                  │                  │       │
│         ▼                                  ▼                  ▼       │
│  ┌─────────────┐                  ┌────────────────┐   ┌────────────┐ │
│  │ ABORTING_   │                  │ COMMITTING_    │   │ ABORTABLE_ │ │
│  │ TRANSACTION │                  │ TRANSACTION    │   │ ERROR      │ │
│  └──────┬──────┘                  └───────┬────────┘   └─────┬──────┘ │
│         │                                 │                  │       │
│         ▼                                 ▼                  ▼       │
│  ┌─────────────┐                  ┌──────────────┐    ┌────────────┐ │
│  │    READY    │                  │    READY     │    │   READY    │ │
│  │  (中止成功)  │                  │  (提交成功)   │    │  (中止成功) │ │
│  └─────────────┘                  └──────────────┘    └────────────┘ │
│                                                                         │
│  任何状态 ─────────────────────────────────────────────────────────▶   │
│                      ┌─────────────┐                                   │
│                      │  FATAL_ERROR│                                   │
│                      └─────────────┘                                   │
│                      （生产者必须关闭）                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 状态转换源码分析

```java
/**
 * 状态转换方法
 */
private void transitionTo(State targetState) {
    State currentState = this.state;

    // 验证状态转换是否合法
    switch (targetState) {
        case INITIALIZING:
            if (currentState != State.UNINITIALIZED) {
                throw new IllegalStateException(
                    "Cannot transition from " + currentState + " to INITIALIZING");
            }
            break;

        case READY:
            if (currentState != State.INITIALIZING
                && currentState != State.COMMITTING_TRANSACTION
                && currentState != State.ABORTING_TRANSACTION
                && currentState != State.ABORTABLE_ERROR) {
                throw new IllegalStateException(
                    "Cannot transition from " + currentState + " to READY");
            }
            break;

        case IN_TRANSACTION:
            if (currentState != State.READY) {
                throw new IllegalStateException(
                    "Cannot call beginTransaction before initTransactions");
            }
            break;

        case COMMITTING_TRANSACTION:
            if (currentState != State.IN_TRANSACTION) {
                throw new IllegalStateException(
                    "Cannot commit if not in transaction");
            }
            break;

        case ABORTING_TRANSACTION:
            if (currentState != State.IN_TRANSACTION
                && currentState != State.ABORTABLE_ERROR) {
                throw new IllegalStateException(
                    "Cannot abort if not in transaction or abortable error");
            }
            break;

        case FATAL_ERROR:
            // 任何状态都可以转到 FATAL_ERROR
            break;
    }

    this.state = targetState;
}
```

---

## 4. 事务操作流程

### 4.1 initTransactions() - 初始化

```java
/**
 * 初始化事务状态，获取 Producer ID
 */
public void initTransactions() {
    ensureTransactional();

    // 验证状态
    if (currentState != State.UNINITIALIZED) {
        throw new IllegalStateException(
            "Cannot call initTransactions again after successful init");
    }

    // 转换为 INITIALIZING 状态
    transitionTo(State.INITIALIZING);

    // 构建 InitProducerId 请求
    InitProducerIdRequest.Builder builder = new InitProducerIdRequest.Builder(
        transactionalId,
        transactionTimeoutMs
    );

    // 发送请求，获取 PID
    enqueueRequest(builder, (response) -> {
        InitProducerIdResponse initResponse = (InitProducerIdResponse) response;

        if (initResponse.error() == Errors.NONE) {
            // 成功获取 PID
            producerIdAndEpoch = new ProducerIdAndEpoch(
                initResponse.producerId(),
                initResponse.epoch()
            );

            // 初始化序列号
            sequenceNumbers.clear();
            lastAckedSequence.clear();

            // 转换到 READY 状态
            transitionTo(State.READY);
        } else {
            // 处理错误
            handleInitProducerIdError(initResponse.error());
        }
    });
}
```

**InitProducerId 流程**：

```
Producer                              TransactionCoordinator
  │                                           │
  │  1. InitProducerIdRequest                 │
  │     (transactional_id, timeout)           │
  │ ─────────────────────────────────────────▶│
  │                                           │
  │                                           │ 2. 检查/创建事务状态
  │                                           │    - 如果是新事务，分配 PID
  │                                           │    - 如果是已有事务，递增 Epoch
  │                                           │      (fencing 旧生产者)
  │                                           │
  │  3. InitProducerIdResponse                │
  │     (producer_id, epoch)                  │
  │ ◀─────────────────────────────────────────│
```

### 4.2 beginTransaction() - 开始事务

```java
/**
 * 开始一个新事务
 */
public void beginTransaction() throws ProducerFencedException {
    ensureTransactional();

    // 验证状态
    if (currentState != State.READY) {
        throw new IllegalStateException(
            "Cannot begin a transaction before initTransactions");
    }

    // 清理上一次事务的状态
    partitionsInTransaction.clear();
    pendingPartitionsInTransaction.clear();
    partitionsAdded.clear();

    // 转换到 IN_TRANSACTION 状态
    transitionTo(State.IN_TRANSACTION);
}
```

### 4.3 sendOffsetsToTransaction() - 发送 Offset

```java
/**
 * 将消费者位移发送到事务中
 * 用于消费-生产原子性：消费消息后，将位移提交与消息发送作为同一事务
 */
public void sendOffsetsToTransaction(
        Map<TopicPartition, OffsetAndMetadata> offsets,
        ConsumerGroupMetadata groupMetadata) throws ProducerFencedException {

    ensureTransactional();

    // 验证状态
    if (currentState != State.IN_TRANSACTION) {
        throw new KafkaException(
            "Cannot send offsets if not in transaction");
    }

    // 添加到待发送列表
    pendingTxnOffsetCommits.put(groupMetadata, offsets);

    // 设置消费者组协调器
    this.consumerGroupCoordinator = groupMetadata.coordinator();
}

/**
 * 实际发送 TxnOffsetCommit 请求
 */
void sendTxnOffsetCommitRequest() {
    for (Map.Entry<ConsumerGroupMetadata, Map<TopicPartition, OffsetAndMetadata>> entry :
         pendingTxnOffsetCommits.entrySet()) {

        ConsumerGroupMetadata groupMetadata = entry.getKey();
        Map<TopicPartition, OffsetAndMetadata> offsets = entry.getValue();

        TxnOffsetCommitRequest.Builder builder = new TxnOffsetCommitRequest.Builder(
            groupMetadata.groupId(),
            producerIdAndEpoch.producerId,
            producerIdAndEpoch.epoch,
            offsets
        );

        // 发送请求
        enqueueRequest(builder, (response) -> {
            TxnOffsetCommitResponse commitResponse = (TxnOffsetCommitResponse) response;
            handleTxnOffsetCommitResponse(commitResponse);
        });
    }

    pendingTxnOffsetCommits.clear();
}
```

### 4.4 commitTransaction() - 提交事务

```java
/**
 * 提交当前事务
 */
public void commitTransaction() throws ProducerFencedException {
    ensureTransactional();

    // 验证状态
    if (currentState != State.IN_TRANSACTION) {
        throw new IllegalStateException(
            "Cannot commit if not in transaction");
    }

    // 转换到 COMMITTING_TRANSACTION 状态
    transitionTo(State.COMMITTING_TRANSACTION);

    // 1. 发送所有未发送的 TxnOffsetCommit 请求
    sendTxnOffsetCommitRequest();

    // 2. 等待所有 Produce 请求完成
    waitForAllBatchesToComplete();

    // 3. 发送 EndTxn 请求（提交）
    EndTxnRequest.Builder builder = new EndTxnRequest.Builder(
        transactionalId,
        producerIdAndEpoch.producerId,
        producerIdAndEpoch.epoch,
        TransactionResult.COMMIT
    );

    enqueueRequest(builder, (response) -> {
        EndTxnResponse endTxnResponse = (EndTxnResponse) response;

        if (endTxnResponse.error() == Errors.NONE) {
            // 事务提交成功
            transitionTo(State.READY);
        } else {
            handleEndTxnError(endTxnResponse.error());
        }
    });
}
```

**事务提交流程**：

```
Producer         Broker(s)          GroupCoordinator    TransactionCoordinator
  │                  │                    │                      │
  │  1. Produce      │                    │                      │
  │  (with PID/Epoch)│                    │                      │
  │ ────────────────▶│                    │                      │
  │                  │                    │                      │
  │  2. Produce      │                    │                      │
  │  (with PID/Epoch)│                    │                      │
  │ ────────────────▶│                    │                      │
  │                  │                    │                      │
  │  3. TxnOffsetCommit                   │                      │
  │  (pending offsets)                    │                      │
  │ ──────────────────────────────────────▶                      │
  │                  │                    │                      │
  │  4. commitTransaction()                                      │
  │                  │                    │                      │
  │  5. EndTxn(COMMIT)                                           │
  │ ─────────────────────────────────────────────────────────────▶│
  │                  │                    │                      │
  │                  │                    │    6. 写入事务标记    │
  │                  │                    │       (COMMIT)       │
  │                  │                    │                      │
  │  7. 事务完成     │                    │                      │
  │ ◀────────────────────────────────────────────────────────────│
```

### 4.5 abortTransaction() - 中止事务

```java
/**
 * 中止当前事务
 */
public void abortTransaction() throws ProducerFencedException {
    ensureTransactional();

    // 验证状态
    if (currentState != State.IN_TRANSACTION
        && currentState != State.ABORTABLE_ERROR) {
        throw new IllegalStateException(
            "Cannot abort if not in transaction or abortable error");
    }

    // 转换到 ABORTING_TRANSACTION 状态
    transitionTo(State.ABORTING_TRANSACTION);

    // 1. 清空所有未完成请求
    abortAllPendingBatches();

    // 2. 清空未发送的位移提交
    pendingTxnOffsetCommits.clear();

    // 3. 发送 EndTxn 请求（中止）
    EndTxnRequest.Builder builder = new EndTxnRequest.Builder(
        transactionalId,
        producerIdAndEpoch.producerId,
        producerIdAndEpoch.epoch,
        TransactionResult.ABORT
    );

    enqueueRequest(builder, (response) -> {
        EndTxnResponse endTxnResponse = (EndTxnResponse) response;

        if (endTxnResponse.error() == Errors.NONE) {
            // 事务中止成功
            transitionTo(State.READY);
        } else {
            handleEndTxnError(endTxnResponse.error());
        }
    });
}
```

---

## 5. 幂等性实现

### 5.1 PID (Producer ID) 分配

```java
/**
 * Producer ID 和 Epoch 信息
 */
public static class ProducerIdAndEpoch {
    public static final ProducerIdAndEpoch NONE = new ProducerIdAndEpoch(-1, (short) -1);

    public final long producerId;   // 生产者唯一标识
    public final short epoch;       // 生产者世代号

    public ProducerIdAndEpoch(long producerId, short epoch) {
        this.producerId = producerId;
        this.epoch = epoch;
    }
}
```

**Epoch 的作用**：

```
场景：生产者实例 A 崩溃，新实例 B 启动

1. 实例 A 持有 PID=100, Epoch=0
2. A 崩溃
3. 实例 B 启动，申请相同 transactional.id
4. Coordinator 返回 PID=100, Epoch=1
5. A 如果恢复并尝试发送消息：
   - PID=100, Epoch=0
   - Broker 发现 Epoch 不匹配
   - 返回 PRODUCER_FENCED 错误
   - A 必须关闭（被 fence 掉）
```

### 5.2 Sequence Number 管理

```java
/**
 * 序列号管理
 */
public class TransactionManager {
    // 每个分区的下一个序列号
    private final Map<TopicPartition, Integer> sequenceNumbers;

    /**
     * 获取下一个序列号
     */
    public synchronized int sequenceNumber(TopicPartition topicPartition) {
        return sequenceNumbers.getOrDefault(topicPartition, 0);
    }

    /**
     * 递增序列号
     */
    public synchronized void incrementSequenceNumber(TopicPartition topicPartition, int increment) {
        int current = sequenceNumbers.getOrDefault(topicPartition, 0);
        sequenceNumbers.put(topicPartition, current + increment);
    }
}

/**
 * ProducerBatch 中包含序列号信息
 */
public final class ProducerBatch {
    // 该批次的起始序列号
    private final int baseSequence;

    // 该批次的 Producer ID
    private final long producerId;

    // 该批次的 Epoch
    private final short producerEpoch;
}
```

### 5.3 去重机制

```
Broker 端去重：

每个分区维护：
┌──────────────────────────────────────────────────────┐
│                   Partition Log                       │
├──────────────────────────────────────────────────────┤
│  PID: 100                                            │
│  Current Epoch: 1                                    │
│  Last Sequence: 5  ← 最后确认的序列号                 │
│                                                      │
│  已确认的消息：                                       │
│  ┌─────────┬─────────┬─────────┬─────────┐           │
│  │ Seq: 0  │ Seq: 1  │ Seq: 2  │ Seq: 3  │ ...       │
│  │ Offset:0│ Offset:1│ Offset:2│ Offset:5│           │
│  └─────────┴─────────┴─────────┴─────────┘           │
└──────────────────────────────────────────────────────┘

新消息到达时的检查：
1. PID 是否存在？
   - 不存在：新生产者，接受消息
   - 存在：检查 Epoch

2. Epoch 是否匹配？
   - 小于当前 Epoch：生产者已被 fence，拒绝
   - 等于当前 Epoch：继续检查序列号
   - 大于当前 Epoch：异常情况

3. Sequence Number 检查：
   - Seq < Last Sequence: 重复消息，丢弃但返回成功
   - Seq = Last Sequence + 1: 正常顺序，接受
   - Seq > Last Sequence + 1: 消息丢失，返回 OUT_OF_ORDER_SEQUENCE
```

```java
/**
 * Broker 端去重逻辑（简化版）
 */
class ProducerStateEntry {
    long producerId;
    short epoch;
    int lastSequence;
    long lastOffset;

    boolean isDuplicate(int sequence) {
        return sequence <= lastSequence;
    }

    boolean isValidSequence(int sequence) {
        return sequence == lastSequence + 1;
    }
}

void validateAndAppend(ProducerStateEntry entry, int sequence, Record record) {
    if (entry.epoch < expectedEpoch) {
        throw new ProducerFencedException("Producer fenced by new epoch");
    }

    if (entry.isDuplicate(sequence)) {
        // 重复消息，忽略但返回成功
        return;
    }

    if (!entry.isValidSequence(sequence)) {
        throw new OutOfOrderSequenceException("Invalid sequence number");
    }

    // 正常消息，追加到日志
    append(record);
    entry.lastSequence = sequence;
}
```

---

## 6. 事务超时与恢复

### 6.1 transaction.timeout.ms

```java
/**
 * 事务超时配置（默认 60000ms = 1分钟）
 */
props.put("transaction.timeout.ms", 60000);

/**
 * 超时检查在 TransactionCoordinator 中进行：
 */
class TransactionCoordinator {
    void maybeExpireTransactions() {
        for (TransactionMetadata txn : activeTransactions) {
            if (txn.isExpired(transactionTimeoutMs)) {
                // 超时事务强制中止
                abortTransaction(txn);
            }
        }
    }
}
```

### 6.2 超时处理流程

```
事务超时处理：

1. 生产者开始事务
   beginTransaction()

2. 发送若干消息
   producer.send(...) × N

3. 生产者崩溃或网络中断
   (事务处于 IN_TRANSACTION 状态)

4. 事务超时（默认 60 秒）
   TransactionCoordinator 检测到超时

5. 协调器强制中止事务
   - 写入 Abort 标记到 __transaction_state
   - 通知相关 Broker 丢弃未确认消息

6. 消费者可见性
   - 事务中的消息对消费者不可见
   - 直到事务提交后才可见（read_committed 隔离级别）
```

### 6.3 事务恢复机制

```java
/**
 * 生产者重启后的事务恢复
 */
public void initTransactions() {
    // 发送 InitProducerId 请求
    // Coordinator 可能返回之前的 PID 并递增 Epoch
    // 这会 fence 掉崩溃的旧生产者实例

    // 可能的情况：
    // 1. 无未完成事务：正常初始化
    // 2. 有未完成事务：
    //    - 已提交：保持提交状态
    //    - 未提交：等待超时后中止，或新生产者决定提交/中止
}
```

**事务恢复流程**：

```
Producer 崩溃后重启：

1. 新实例启动，调用 initTransactions()

2. 申请相同 transactional.id

3. Coordinator 响应：
   ┌─────────────────────────────────────────────────────────────┐
   │ 情况 A: 无未完成事务                                         │
   │ - 返回新 PID                                                │
   │ - 正常开始新事务                                            │
   ├─────────────────────────────────────────────────────────────┤
   │ 情况 B: 有待提交事务                                         │
   │ - 返回相同 PID，Epoch+1                                     │
   │ - fence 旧生产者                                            │
   │ - 允许新生产者决定提交或中止                                │
   ├─────────────────────────────────────────────────────────────┤
   │ 情况 C: 事务已超时                                           │
   │ - Coordinator 已自动中止                                    │
   │ - 返回相同 PID，Epoch+1                                     │
   │ - 新生产者可以开始新事务                                    │
   └─────────────────────────────────────────────────────────────┘

4. 新生产者可以继续发送消息
```

---

**上一章**: [06. Producer 拦截器](./06-interceptors.md)
**下一章**: [08. Producer 配置详解](./08-producer-config.md)
