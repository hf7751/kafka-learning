# 02. Fetcher 拉取机制详解

本文档深入分析 Kafka Consumer 的消息拉取机制，了解 Consumer 如何从 Broker 高效获取消息。

## 目录
- [1. Fetcher 概述](#1-fetcher-概述)
- [2. Fetcher 核心结构](#2-fetcher-核心结构)
- [3. Fetch 请求构建](#3-fetch-请求构建)
- [4. 响应处理与解析](#4-响应处理与解析)
- [5. Fetch Session 机制](#5-fetch-session-机制)
- [6. 增量拉取优化](#6-增量拉取优化)

---

## 1. Fetcher 概述

### 1.1 Fetcher 的职责

Fetcher 是 Kafka Consumer 的核心组件，负责从 Broker 拉取消息：

| 职责 | 说明 |
|-----|------|
| **构建 Fetch 请求** | 根据订阅的分区构建批量拉取请求 |
| **管理 Fetch Session** | 维护与 Broker 的增量拉取会话 |
| **处理响应数据** | 解压、解析 RecordBatch |
| **缓存消息** | 将拉取的消息缓存供 poll() 返回 |
| **位移管理** | 跟踪每个分区的消费位置 |

### 1.2 与 KafkaConsumer 的关系

```
┌─────────────────────────────────────────────────────────────────┐
│                       KafkaConsumer                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐         ┌──────────────────────────────┐  │
│  │   poll()        │────────▶│           Fetcher            │  │
│  │                 │         │                              │  │
│  │  1. 调用        │         │  ┌────────────────────────┐  │  │
│  │     sendFetches │         │  │   sendFetches()        │  │  │
│  │                 │         │  │   - 构建 Fetch 请求    │  │  │
│  │  2. 调用        │         │  │   - 发送到各 Broker    │  │  │
│  │     fetchedRec  │         │  └────────────────────────┘  │  │
│  │                 │         │                              │  │
│  │                 │         │  ┌────────────────────────┐  │  │
│  │                 │         │  │   fetchedRecords()     │  │  │
│  │                 │────────▶│  │   - 返回缓存的消息     │  │  │
│  │                 │         │  │   - 更新消费位置       │  │  │
│  └─────────────────┘         │  └────────────────────────┘  │  │
│                              │                              │  │
│                              │  ┌────────────────────────┐  │  │
│                              │  │   FetchSessionHandler  │  │  │
│                              │  │   - 管理增量拉取       │  │  │
│                              │  └────────────────────────┘  │  │
│                              └──────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 核心参数

```java
public class Fetcher<K, V> implements Closeable {
    // 消费组 ID
    private final String clientId;

    // 网络客户端
    private final ConsumerNetworkClient client;

    // 订阅状态
    private final SubscriptionState subscriptions;

    // Fetch Session 管理器
    private final Map<Integer, FetchSessionHandler> sessionHandlers;

    // 已完成的 Fetch 队列
    private final Queue<CompletedFetch> completedFetches;

    // 已解析的记录缓存
    private final Map<TopicPartition, List<ConsumerRecord<K, V>>> cachedRecords;

    // 配置参数
    private final int minBytes;           // fetch.min.bytes
    private final int maxBytes;           // fetch.max.bytes
    private final int maxWaitMs;          // fetch.max.wait.ms
    private final int fetchSize;          // max.partition.fetch.bytes
    private final int maxPollRecords;     // max.poll.records
    private final String isolationLevel;  // isolation.level
}
```

---

## 2. Fetcher 核心结构

### 2.1 Fetcher 类结构

```java
public class Fetcher<K, V> implements Closeable {

    /**
     * 发送 Fetch 请求到所有有数据需求的分区对应的 Broker
     */
    public synchronized int sendFetches() {
        // 1. 按节点分组需要拉取的分区
        Map<Node, FetchSessionHandler.FetchRequestData> fetchRequestMap =
            prepareFetchRequests();

        // 2. 为每个节点创建并发送 Fetch 请求
        for (Map.Entry<Node, FetchSessionHandler.FetchRequestData> entry :
             fetchRequestMap.entrySet()) {

            Node node = entry.getKey();
            FetchSessionHandler.FetchRequestData data = entry.getValue();

            // 构建 Fetch 请求
            FetchRequest.Builder request = createFetchRequest(node, data);

            // 发送请求并设置回调
            client.send(request, new FetchResponseCallback());
        }

        return fetchRequestMap.size();
    }

    /**
     * 获取已拉取的消息记录
     */
    public Map<TopicPartition, List<ConsumerRecord<K, V>>> fetchedRecords() {
        Map<TopicPartition, List<ConsumerRecord<K, V>>> fetched = new HashMap<>();
        Queue<CompletedFetch> pausedCompletedFetches = new ArrayDeque<>();

        int recordsRemaining = maxPollRecords;

        // 处理已完成的 Fetch
        while (recordsRemaining > 0) {
            CompletedFetch completedFetch = completedFetches.poll();
            if (completedFetch == null) break;

            // 解析并添加记录
            List<ConsumerRecord<K, V>> records = parseCompletedFetch(completedFetch);
            fetched.put(completedFetch.partition, records);
            recordsRemaining -= records.size();
        }

        return fetched;
    }
}
```

### 2.2 CompletedFetch 解析

```java
/**
 * 表示一个已完成的 Fetch 响应
 */
private static class CompletedFetch {
    // 目标分区
    final TopicPartition partition;

    // 下次拉取位置
    final long nextFetchOffset;

    // 拉取的数据
    final FetchResponseData.PartitionData partitionData;

    // 压缩类型
    final CompressionType compressionType;

    // 数据缓存
    final ByteBuffer responseBuffer;

    // 记录迭代器
    Iterator<Record> records;

    // 是否已解压
    boolean initialized = false;

    /**
     * 初始化并解压记录
     */
    void initialize() {
        if (initialized) return;

        // 1. 解压数据
        ByteBuffer decompressed = decompress(responseBuffer, compressionType);

        // 2. 解析 RecordBatch
        MemoryRecords memoryRecords = MemoryRecords.readableRecords(decompressed);

        // 3. 创建记录迭代器
        this.records = memoryRecords.records().iterator();

        this.initialized = true;
    }
}
```

### 2.3 PartitionRecords 封装

```java
/**
 * 分区记录列表，包含消费位置信息
 */
private static class PartitionRecords<K, V> {
    // 目标分区
    final TopicPartition partition;

    // 记录列表
    final List<ConsumerRecord<K, V>> records;

    // 记录数量
    final int numRecords;

    // 最后一条记录的 Offset
    final long lastOffset;

    // 最后一条记录的时间戳
    final long lastTimestamp;

    PartitionRecords(TopicPartition partition, List<ConsumerRecord<K, V>> records) {
        this.partition = partition;
        this.records = records;
        this.numRecords = records.size();

        if (!records.isEmpty()) {
            ConsumerRecord<K, V> lastRecord = records.get(records.size() - 1);
            this.lastOffset = lastRecord.offset();
            this.lastTimestamp = lastRecord.timestamp();
        } else {
            this.lastOffset = -1;
            this.lastTimestamp = -1;
        }
    }
}
```

### 2.4 FetchPosition 管理

```java
/**
 * 管理每个分区的拉取位置
 */
public class SubscriptionState {

    private static class TopicPartitionState {
        // 当前消费位置
        private Long position;

        // 已确认的提交位置
        private OffsetAndMetadata committed;

        // 是否暂停消费
        private boolean paused;

        // 是否正在追赶（重置 offset 后）
        private boolean fetching;

        // 最后消费记录的时间戳
        private Long lastConsumedTimestamp;
    }

    /**
     * 获取分区的拉取位置
     */
    public synchronized Long position(TopicPartition tp) {
        TopicPartitionState state = assignedState(tp);
        return state.position;
    }

    /**
     * 更新消费位置（消费消息后调用）
     */
    public synchronized void position(TopicPartition tp, long offset) {
        TopicPartitionState state = assignedState(tp);
        state.position = offset;
    }
}
```

---

## 3. Fetch 请求构建

### 3.1 createFetchRequests() 流程

```java
/**
 * 准备 Fetch 请求
 */
private Map<Node, FetchSessionHandler.FetchRequestData> prepareFetchRequests() {
    Map<Node, FetchSessionHandler.FetchRequestData> result = new HashMap<>();

    // 获取所有需要拉取的分区
    Set<TopicPartition> partitions = subscriptions.fetchablePartitions();

    for (TopicPartition partition : partitions) {
        // 获取分区信息
        SubscriptionState.FetchPosition position = subscriptions.position(partition);
        Node node = metadata.fetch().leaderFor(partition);

        if (node == null || node.isEmpty()) {
            // Leader 未知，需要更新元数据
            metadata.requestUpdate();
            continue;
        }

        // 获取或创建该节点的 FetchSessionHandler
        FetchSessionHandler sessionHandler = sessionHandlers.computeIfAbsent(
            node.id(), id -> new FetchSessionHandler(logContext, id));

        // 添加分区到请求
        FetchSessionHandler.Builder builder = result
            .computeIfAbsent(node, k -> sessionHandler.newBuilder())
            .add(partition, new FetchRequest.PartitionData(
                position.offset,                    // fetch offset
                position.currentLeader.epoch,       // current leader epoch
                fetchSize,                          // max bytes
                Optional.empty()                    // last fetched epoch
            ));
    }

    return result;
}
```

### 3.2 FetchRequest 数据结构

```java
/**
 * Fetch 请求结构
 */
public class FetchRequest extends AbstractRequest {

    public static final class PartitionData {
        public final long fetchOffset;           // 拉取起始 Offset
        public final int currentLeaderEpoch;     // 当前 Leader Epoch
        public final int maxBytes;               // 最大字节数
        public final Optional<Integer> lastFetchedEpoch; // 最后拉取 Epoch
    }

    // 请求参数
    private final int replicaId;           // 副本 ID（普通 Consumer 为 -1）
    private final int maxWaitMs;           // 最大等待时间
    private final int minBytes;            // 最小字节数
    private final int maxBytes;            // 最大字节数
    private final IsolationLevel isolationLevel;  // 隔离级别

    // 要拉取的分区
    private final Map<TopicPartition, PartitionData> toFetch;

    // Fetch Session ID（增量拉取使用）
    private final int sessionId;
    private final int sessionEpoch;
}
```

### 3.3 节点分组策略

```java
/**
 * 按 Broker 节点分组分区
 */
private Map<Node, List<TopicPartition>> groupPartitionsByNode() {
    Map<Node, List<TopicPartition>> result = new HashMap<>();

    Cluster cluster = metadata.fetch();

    for (TopicPartition partition : subscriptions.fetchablePartitions()) {
        Node leader = cluster.leaderFor(partition);

        if (leader != null && !leader.isEmpty()) {
            result.computeIfAbsent(leader, k -> new ArrayList<>())
                  .add(partition);
        }
    }

    return result;
}

/**
 * 分组结果示例：
 *
 * Node1 (broker-1:9092):
 *   - topic-a-0, topic-a-1, topic-b-0
 *
 * Node2 (broker-2:9092):
 *   - topic-a-2, topic-c-0, topic-c-1
 *
 * Node3 (broker-3:9092):
 *   - topic-b-1, topic-b-2, topic-c-2
 */
```

### 3.4 fetch.max.bytes 限制处理

```java
/**
 * 处理单请求大小限制
 */
private void maybeUpdateMinAndMaxBytes() {
    // 计算每个分区的 maxBytes
    int totalPartitions = fetchablePartitions.size();
    int bytesPerPartition = Math.max(1, maxBytes / totalPartitions);

    for (TopicPartition partition : fetchablePartitions) {
        PartitionData data = partitionData.get(partition);

        // 限制单个分区的拉取大小
        int partitionMaxBytes = Math.min(data.maxBytes, bytesPerPartition);

        // 确保至少能拉取一条消息
        partitionMaxBytes = Math.max(partitionMaxBytes, MIN_MESSAGE_SIZE);

        data.maxBytes = partitionMaxBytes;
    }
}
```

---

## 4. 响应处理与解析

### 4.1 FetchResponse 处理

```java
/**
 * Fetch 响应回调
 */
private class FetchResponseCallback implements RequestFutureListener<ClientResponse> {

    @Override
    public void onSuccess(ClientResponse response) {
        FetchResponse fetchResponse = (FetchResponse) response.responseBody();

        // 获取该节点的 FetchSessionHandler
        FetchSessionHandler sessionHandler = sessionHandlers.get(response.destination());

        // 处理响应
        FetchSessionHandler.FetchResponseData responseData =
            sessionHandler.handleResponse(fetchResponse);

        // 处理每个分区的数据
        for (Map.Entry<TopicPartition, FetchResponseData.PartitionData> entry :
             responseData.responseData().entrySet()) {

            TopicPartition partition = entry.getKey();
            FetchResponseData.PartitionData partitionData = entry.getValue();

            // 检查错误码
            Errors error = Errors.forCode(partitionData.errorCode());

            if (error == Errors.NONE) {
                // 成功，创建 CompletedFetch
                CompletedFetch completedFetch = new CompletedFetch(
                    partition,
                    partitionData,
                    subscriptions.position(partition).offset
                );

                completedFetches.add(completedFetch);

            } else {
                // 处理错误
                handleFetchError(partition, error);
            }
        }
    }

    @Override
    public void onFailure(RuntimeException e) {
        // 请求失败，重试
        log.warn("Fetch request failed", e);
    }
}
```

### 4.2 RecordBatch 解压

```java
/**
 * 解压并解析 RecordBatch
 */
private Iterator<Record> decompressRecords(CompletedFetch completedFetch) {
    ByteBuffer buffer = completedFetch.responseBuffer;
    CompressionType compressionType = completedFetch.compressionType;

    // 1. 解压数据
    ByteBuffer decompressed;
    switch (compressionType) {
        case NONE:
            decompressed = buffer;
            break;
        case GZIP:
            decompressed = decompressGzip(buffer);
            break;
        case SNAPPY:
            decompressed = decompressSnappy(buffer);
            break;
        case LZ4:
            decompressed = decompressLz4(buffer);
            break;
        case ZSTD:
            decompressed = decompressZstd(buffer);
            break;
        default:
            throw new IllegalStateException("Unknown compression type");
    }

    // 2. 解析 MemoryRecords
    MemoryRecords records = MemoryRecords.readableRecords(decompressed);

    // 3. 返回记录迭代器
    return records.records().iterator();
}
```

### 4.3 ConsumerRecord 构建

```java
/**
 * 从 Record 构建 ConsumerRecord
 */
private ConsumerRecord<K, V> parseRecord(TopicPartition partition,
                                         Record record,
                                         Deserializers deserializers) {
    // 反序列化 key
    K key = deserializers.keyDeserializer.deserialize(
        partition.topic(),
        record.key()
    );

    // 反序列化 value
    V value = deserializers.valueDeserializer.deserialize(
        partition.topic(),
        record.value()
    );

    // 获取 headers
    Headers headers = new RecordHeaders(record.headers());

    // 构建 ConsumerRecord
    return new ConsumerRecord<>(
        partition.topic(),           // topic
        partition.partition(),       // partition
        record.offset(),             // offset
        record.timestamp(),          // timestamp
        record.timestampType(),      // timestamp type
        record.serializedKeySize(),  // serialized key size
        record.serializedValueSize(), // serialized value size
        key,                         // key
        value,                       // value
        headers,                     // headers
        record.leaderEpoch()         // leader epoch
    );
}
```

### 4.4 异常处理与重试

```java
/**
 * 处理 Fetch 错误
 */
private void handleFetchError(TopicPartition partition, Errors error) {
    switch (error) {
        case OFFSET_OUT_OF_RANGE:
            // Offset 超出范围，需要重置
            long position = subscriptions.position(partition);
            log.warn("Fetch offset {} is out of range for partition {}",
                position, partition);

            // 根据 auto.offset.reset 策略处理
            OffsetResetStrategy strategy = subscriptions.resetStrategy(partition);
            subscriptions.requestOffsetReset(partition, strategy);
            break;

        case UNKNOWN_TOPIC_OR_PARTITION:
        case NOT_LEADER_OR_FOLLOWER:
            // 需要更新元数据
            log.debug("Error fetching partition {}: {}", partition, error);
            metadata.requestUpdate();
            break;

        case TOPIC_AUTHORIZATION_FAILED:
            // 权限错误，抛出异常
            throw new TopicAuthorizationException(partition.topic());

        case KAFKA_STORAGE_ERROR:
            // 存储错误，稍后重试
            log.warn("Kafka storage error fetching partition {}", partition);
            break;

        default:
            // 其他错误，记录日志
            log.warn("Unknown error fetching partition {}: {}", partition, error);
    }
}
```

---

## 5. Fetch Session 机制

### 5.1 什么是 Fetch Session

Fetch Session 是 Kafka 1.1.0+ 引入的优化机制，用于减少 Fetch 请求的大小：

```
传统 Fetch 请求（每次全量）：
┌─────────────────────────────────────────────────────────────┐
│ FetchRequest                                                │
├─────────────────────────────────────────────────────────────┤
│ Partitions: [tp-0, tp-1, tp-2, tp-3, tp-4, tp-5, ...]      │
│ - tp-0: offset=100                                          │
│ - tp-1: offset=200                                          │
│ - tp-2: offset=150                                          │
│ - ... (所有订阅的分区)                                       │
└─────────────────────────────────────────────────────────────┘
每次请求都要发送完整的分区列表

Fetch Session 请求（增量）：
┌─────────────────────────────────────────────────────────────┐
│ FetchRequest (Session ID: 12345)                            │
├─────────────────────────────────────────────────────────────┤
│ Session ID: 12345                                           │
│ Epoch: 5                                                    │
│ Changes:                                                    │
│   - tp-0: offset=110 (updated)                              │
│   - tp-5: NEW                                               │
│   - tp-2: REMOVED                                           │
└─────────────────────────────────────────────────────────────┘
只发送变更的分区信息
```

### 5.2 Fetch Session 建立

```java
/**
 * Fetch Session 处理器
 */
public class FetchSessionHandler {

    // Session ID，由 Broker 分配
    private int sessionId = INVALID_SESSION_ID;

    // Session 世代号
    private int sessionEpoch = INITIAL_EPOCH;

    // Session 中的分区状态
    private Map<TopicPartition, PartitionData> sessionPartitions = new HashMap<>();

    /**
     * 构建 Fetch 请求
     */
    public FetchRequest.Builder newBuilder() {
        // 计算分区变更
        Map<TopicPartition, PartitionData> toSend = new HashMap<>();
        Set<TopicPartition> toForget = new HashSet<>();

        // 对比当前订阅与 Session 中的分区
        for (TopicPartition partition : currentPartitions) {
            PartitionData data = currentData.get(partition);
            PartitionData sessionData = sessionPartitions.get(partition);

            if (sessionData == null) {
                // 新分区，需要添加
                toSend.put(partition, data);
            } else if (data.fetchOffset != sessionData.fetchOffset) {
                // Offset 变化，需要更新
                toSend.put(partition, data);
            }
        }

        // 找出需要移除的分区
        for (TopicPartition partition : sessionPartitions.keySet()) {
            if (!currentPartitions.contains(partition)) {
                toForget.add(partition);
            }
        }

        // 更新 Session 世代号
        if (sessionId != INVALID_SESSION_ID) {
            sessionEpoch++;
        }

        return new FetchRequest.Builder(
            sessionId,
            sessionEpoch,
            toSend,
            toForget
        );
    }
}
```

### 5.3 增量 Fetch 请求

```java
/**
 * 增量 Fetch 请求类型
 */
public enum FetchType {
    FULL,        // 全量请求（新 Session 或 Session 过期）
    INCREMENTAL  // 增量请求（只发送变更）
}

/**
 * 构建增量请求
 */
FetchRequest.Builder buildIncrementalFetchRequest() {
    // 如果没有 Session，发送全量请求
    if (sessionId == INVALID_SESSION_ID) {
        return buildFullFetchRequest();
    }

    // 计算增量变更
    Map<TopicPartition, PartitionData> updatedPartitions = new HashMap<>();

    for (TopicPartition tp : subscriptions.fetchablePartitions()) {
        FetchPosition position = subscriptions.position(tp);
        PartitionData prevData = sessionPartitions.get(tp);

        if (prevData == null) {
            // 新增分区
            updatedPartitions.put(tp, new PartitionData(
                position.offset,
                position.currentLeader.epoch,
                fetchSize,
                Optional.empty()
            ));
        } else if (position.offset != prevData.fetchOffset) {
            // Offset 更新
            updatedPartitions.put(tp, new PartitionData(
                position.offset,
                prevData.currentLeaderEpoch,
                prevData.maxBytes,
                Optional.empty()
            ));
        }
    }

    return new FetchRequest.Builder(
        sessionId,
        sessionEpoch + 1,
        updatedPartitions,
        Collections.emptyList()
    );
}
```

### 5.4 Session 维护与清理

```java
/**
 * 处理 Fetch 响应，更新 Session
 */
public boolean handleResponse(FetchResponse response) {
    // 获取响应中的 Session 信息
    int responseSessionId = response.sessionId();

    if (responseSessionId == INVALID_SESSION_ID) {
        // Session 被 Broker 关闭，下次需要全量请求
        sessionId = INVALID_SESSION_ID;
        sessionEpoch = INITIAL_EPOCH;
        sessionPartitions.clear();
        return false;
    }

    // 更新 Session ID（如果是新 Session）
    if (sessionId == INVALID_SESSION_ID) {
        sessionId = responseSessionId;
    }

    // 更新 Session 世代号
    sessionEpoch++;

    // 更新 Session 中的分区状态
    for (TopicPartition tp : response.responseData().keySet()) {
        PartitionData data = currentData.get(tp);
        if (data != null) {
            sessionPartitions.put(tp, data);
        }
    }

    return true;
}

/**
 * 关闭 Session
 */
public void close() {
    if (sessionId != INVALID_SESSION_ID) {
        // 发送关闭 Session 的请求
        FetchRequest.Builder builder = new FetchRequest.Builder(
            sessionId,
            FINAL_EPOCH,  // 特殊世代号表示关闭
            Collections.emptyMap(),
            Collections.emptyList()
        );

        client.send(builder);
        sessionId = INVALID_SESSION_ID;
    }
}
```

---

## 6. 增量拉取优化

### 6.1 增量拉取原理

```
全量 Fetch vs 增量 Fetch：

场景：Consumer 订阅 100 个分区，每次只有 10 个分区有更新

全量 Fetch：
- 请求大小：100 个分区 × 50 字节 = 5KB
- 每次请求都发送所有分区信息

增量 Fetch：
- 初始请求（全量）：5KB
- 后续请求（增量）：10 个分区 × 50 字节 = 500 字节
- 节省：90% 的请求大小
```

### 6.2 与全量拉取的对比

| 特性 | 全量 Fetch | 增量 Fetch |
|-----|-----------|-----------|
| 请求大小 | 与分区数成正比 | 与变更数成正比 |
| CPU 占用 | 低 | 略高（需要计算增量） |
| 网络占用 | 高 | 低 |
| Session 状态 | 无状态 | 有状态（需维护 Session） |
| 适用场景 | 分区少、订阅变化频繁 | 分区多、订阅稳定 |

### 6.3 性能提升分析

**测试场景**：Consumer 订阅 500 个分区，50 个 Broker

| 指标 | 全量 Fetch | 增量 Fetch | 提升 |
|-----|-----------|-----------|------|
| 平均请求大小 | 25KB | 3KB | 88% |
| 网络带宽占用 | 100% | 15% | 85% |
| 端到端延迟 | 基准 | -20% | 20% |
| Broker CPU | 基准 | -10% | 10% |

### 6.4 配置调优建议

```java
// 启用 Fetch Session（默认开启，Kafka 1.1+）
// 无需特殊配置，Consumer 自动使用

// 调整 Fetch 参数优化吞吐量
props.put("fetch.min.bytes", 50000);      // 至少拉取 50KB
props.put("fetch.max.wait.ms", 500);       // 最多等待 500ms
props.put("fetch.max.bytes", 52428800);    // 单次最大 50MB
props.put("max.partition.fetch.bytes", 1048576); // 单分区最大 1MB

// 大量分区时的调优
props.put("max.poll.records", 500);        // 单次返回记录数
props.put("max.poll.interval.ms", 300000); // 处理超时
```

**Fetch 参数调优建议**：

| 场景 | fetch.min.bytes | fetch.max.wait.ms | max.poll.records |
|-----|-----------------|-------------------|------------------|
| 高吞吐 | 100KB+ | 500ms+ | 1000 |
| 低延迟 | 1 | 0 | 1-10 |
| 均衡 | 10KB | 100ms | 500 |

---

**上一章**: [01. Consumer 架构概述](./01-consumer-overview.md)
**下一章**: [03. ConsumerCoordinator 消费组协调器](./03-consumer-coordinator.md)
