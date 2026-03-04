# 04. Producer 元数据管理

本文档深入分析 Kafka Producer 的元数据管理机制，了解 Producer 如何发现和维护集群拓扑信息。

## 目录
- [1. Metadata 概述](#1-metadata-概述)
- [2. 元数据结构](#2-元数据结构)
- [3. 元数据更新流程](#3-元数据更新流程)
- [4. 元数据缓存策略](#4-元数据缓存策略)
- [5. 分区信息发现](#5-分区信息发现)

---

## 1. Metadata 概述

### 1.1 为什么需要元数据

Kafka Producer 需要以下集群信息才能正确发送消息：

| 信息类型 | 用途 |
|---------|------|
| **Broker 列表** | 建立网络连接，发送请求 |
| **Topic 分区信息** | 计算消息应该发送到哪个分区 |
| **分区 Leader** | 确定向哪个 Broker 发送消息 |
| **副本信息** | 了解 ISR（In-Sync Replicas）状态 |

```
┌─────────────────────────────────────────────────────────────┐
│                     元数据使用场景                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 发送消息时                  2. 分区计算时                 │
│  ┌─────────────┐               ┌─────────────┐              │
│  │ producer.send│               │ partitioner │              │
│  └──────┬──────┘               └──────┬──────┘              │
│         │                             │                     │
│         ▼                             ▼                     │
│  ┌─────────────┐               ┌─────────────┐              │
│  │ cluster.leader│             │ cluster.partitionCount    │
│  │    (tp)      │              │    (topic)  │              │
│  └─────────────┘               └─────────────┘              │
│         │                             │                     │
│         ▼                             ▼                     │
│  ┌─────────────┐               ┌─────────────┐              │
│  │ 获取目标节点  │               │ 计算分区号   │              │
│  └─────────────┘               └─────────────┘              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 元数据的组成

```java
// Metadata 核心类
public class Metadata implements Closeable {
    // 刷新间隔（默认 5 分钟）
    private final long refreshBackoffMs;
    private final long metadataExpireMs;

    // 版本号，每次更新递增
    private int version;
    // 最后更新时间
    private long lastRefreshMs;
    private long lastSuccessfulRefreshMs;

    // 元数据状态锁
    private final Lock lock;
    private final Condition updateRequested;
    private final Condition updateCompleted;

    // 当前集群元数据（不可变，更新时替换）
    private volatile Cluster cluster;

    // 是否需要更新
    private boolean needUpdate;
    // 监听器列表
    private final List<Listener> listeners;
}
```

### 1.3 元数据更新触发条件

| 触发条件 | 说明 |
|---------|------|
| **定时刷新** | `metadata.max.age.ms` 超时（默认 5 分钟） |
| **发送失败** | 收到 `UNKNOWN_TOPIC_OR_PARTITION` 等错误 |
| **Leader 不可用** | 收到 `NOT_LEADER_OR_FOLLOWER` 错误 |
| **新 Topic** | 发送到一个之前未发送过的 Topic |
| **手动刷新** | 用户调用 `producer.partitionsFor()` |

---

## 2. 元数据结构

### 2.1 Cluster 类结构

```java
public final class Cluster {
    // 集群唯一标识
    private final String clusterResourceId;

    // 节点列表
    private final List<Node> nodes;
    private final Set<Node> nodesById;
    private final Map<Integer, Node> nodesByIdMap;

    // Topic 分区信息
    private final Map<TopicPartition, PartitionInfo> partitionsByTopicPartition;
    private final Map<String, List<PartitionInfo>> partitionsByTopic;
    private final Map<String, Integer> partitionCountByTopic;

    // 可用分区（有 Leader 的分区）
    private final Map<String, List<PartitionInfo>> availablePartitionsByTopic;

    // 节点分区映射
    private final Map<Integer, List<PartitionInfo>> partitionsByNode;

    // 控制器节点
    private final Node controller;
}
```

### 2.2 Node 信息

```java
public class Node implements Comparable<Node> {
    private final int id;           // 节点 ID
    private final String idString;  // 字符串形式的 ID
    private final String host;      // 主机名
    private final int port;         // 端口
    private final String rack;      // 机架信息
    private final boolean hasListener;  // 是否有监听地址

    // 判断节点是否为空（表示节点不可用）
    public static Node noNode() {
        return new Node(-1, "", -1, "");
    }
}
```

### 2.3 TopicPartition 信息

```java
public final class TopicPartition implements Serializable {
    private final int partition;   // 分区号
    private final String topic;    // Topic 名称

    // 用于 Map 键的比较
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        TopicPartition other = (TopicPartition) obj;
        return partition == other.partition && topic.equals(other.topic);
    }

    public int hashCode() {
        int result = topic.hashCode();
        result = 31 * result + partition;
        return result;
    }
}
```

### 2.4 PartitionInfo 详情

```java
public class PartitionInfo {
    private final String topic;           // Topic 名称
    private final int partition;          // 分区号
    private final Node leader;            // Leader 节点
    private final Node[] replicas;        // 所有副本
    private final Node[] inSyncReplicas;  // ISR 副本
    private final Node[] offlineReplicas; // 离线副本

    // 判断分区是否可用
    public boolean isLeaderKnown() {
        return leader != null && !leader.isEmpty();
    }
}
```

**PartitionInfo 示例**：

```
PartitionInfo for "order-topic-0"
├─ topic: "order-topic"
├─ partition: 0
├─ leader: Node(id=1, host=192.168.1.10, port=9092)
├─ replicas: [Node(1), Node(2), Node(3)]
├─ inSyncReplicas: [Node(1), Node(2)]
└─ offlineReplicas: [Node(3)]
```

---

## 3. 元数据更新流程

### 3.1 触发更新的条件

```java
// ProducerMetadata（Producer 专用元数据管理）
public class ProducerMetadata extends Metadata {
    // 需要更新元数据的 Topic 集合
    private final Set<String> newTopics;

    // 检查是否需要更新
    public synchronized boolean shouldRefreshMetadata(long nowMs) {
        // 1. 检查是否强制刷新
        if (needUpdate) return true;

        // 2. 检查是否有过期的元数据
        long timeSinceUpdate = nowMs - lastSuccessfulRefreshMs;
        if (timeSinceUpdate >= metadataExpireMs) return true;

        // 3. 检查是否有新 Topic 需要发现
        if (!newTopics.isEmpty()) return true;

        return false;
    }
}
```

### 3.2 MetadataRequest 构建

```java
// Sender 线程触发元数据请求
private long metadataTimeout(long now) {
    // 如果没有成功刷新过，立即刷新
    if (!metadata.fetch().nodes().isEmpty()) {
        return this.metadataTimeout;
    }
    return 0;
}

// 构建元数据请求
MetadataRequest.Builder metadataRequestBuilder = new MetadataRequest.Builder(
    newMetadataTopics,      // 需要获取元数据的 Topic 列表
    metadata.allowAutoTopicCreation(),  // 是否允许自动创建 Topic
    context                  // 请求上下文
);

// 发送元数据请求
ClientRequest request = client.newClientRequest(
    leastLoadedNode,
    metadataRequestBuilder,
    now,
    true,
    new MetadataUpdateHandler()
);
client.send(request, now);
```

### 3.3 响应处理与缓存更新

```java
// MetadataResponse 处理
public void update(MetadataResponse response, long now) {
    lock.lock();
    try {
        // 1. 解析响应中的节点信息
        Map<Integer, Node> newNodes = new HashMap<>();
        for (MetadataResponse.Node node : response.nodes()) {
            newNodes.put(node.id(), new Node(node.id(), node.host(),
                node.port(), node.rack()));
        }

        // 2. 解析分区信息
        Map<TopicPartition, PartitionInfo> newPartitions = new HashMap<>();
        Map<String, List<PartitionInfo>> newPartitionsByTopic = new HashMap<>();

        for (MetadataResponse.TopicMetadata topicMetadata : response.topicMetadata()) {
            String topic = topicMetadata.topic();
            List<PartitionInfo> partitionInfos = new ArrayList<>();

            for (MetadataResponse.PartitionMetadata partitionMetadata :
                 topicMetadata.partitionMetadata()) {

                TopicPartition tp = new TopicPartition(topic,
                    partitionMetadata.partition());

                Node leader = newNodes.get(partitionMetadata.leaderId());
                Node[] replicas = convertToNodes(newNodes, partitionMetadata.replicaIds());
                Node[] isr = convertToNodes(newNodes, partitionMetadata.inSyncReplicaIds());
                Node[] offline = convertToNodes(newNodes,
                    partitionMetadata.offlineReplicaIds());

                PartitionInfo info = new PartitionInfo(topic,
                    partitionMetadata.partition(), leader, replicas, isr, offline);

                newPartitions.put(tp, info);
                partitionInfos.add(info);
            }

            newPartitionsByTopic.put(topic, partitionInfos);
        }

        // 3. 创建新的 Cluster 对象（不可变）
        Cluster newCluster = new Cluster(response.clusterId(),
            newNodes.values(),
            newPartitions.values(),
            ...);

        // 4. 原子更新
        this.cluster = newCluster;
        this.version++;
        this.lastRefreshMs = now;
        this.lastSuccessfulRefreshMs = now;
        this.needUpdate = false;

        // 5. 唤醒等待的线程
        this.updateCompleted.signalAll();

        // 6. 通知监听器
        for (Listener listener : listeners) {
            listener.onMetadataUpdate(newCluster, response);
        }

    } finally {
        lock.unlock();
    }
}
```

### 3.4 版本号管理

```java
// 版本号用于检测元数据是否更新
private int version;

// 获取当前版本
public synchronized int requestVersion() {
    return this.version;
}

// 使用示例：Sender 线程检测元数据是否过期
public boolean updateRequested() {
    return this.needUpdate;
}

// 等待元数据更新完成
public synchronized void awaitUpdate(int lastVersion, long timeoutMs) {
    long begin = time.milliseconds();
    long remainingWaitMs = timeoutMs;

    while (this.version <= lastVersion) {
        if (remainingWaitMs <= 0) {
            throw new TimeoutException("...");
        }
        updateCompleted.await(remainingWaitMs, TimeUnit.MILLISECONDS);
        remainingWaitMs = timeoutMs - (time.milliseconds() - begin);
    }
}
```

---

## 4. 元数据缓存策略

### 4.1 metadata.max.age.ms

```java
// 元数据最大缓存时间（默认 5 分钟）
private final long metadataExpireMs;

// 检查是否需要刷新
public synchronized boolean updateRequested(long nowMs) {
    long timeSinceUpdate = nowMs - this.lastSuccessfulRefreshMs;
    return timeSinceUpdate >= this.metadataExpireMs;
}
```

**调优建议**：

| 场景 | 建议值 | 说明 |
|-----|-------|------|
| 稳定集群 | 300000（5分钟） | 减少不必要的元数据请求 |
| 频繁变更 | 60000（1分钟） | 更快感知集群变化 |
| 开发测试 | 10000（10秒） | 快速发现新 Topic |

### 4.2 强制更新 vs 后台更新

```java
// 强制更新：阻塞直到元数据更新完成
public synchronized void requestUpdate() {
    this.needUpdate = true;
}

// 后台更新：Sender 线程异步获取
void runOnce() {
    // 检查元数据是否需要更新
    long metadataTimeout = metadataTimeout(now);

    // 如果没有 ready 的节点，先获取元数据
    if (result.readyNodes.isEmpty()) {
        metadata.requestUpdate();
    }
}
```

### 4.3 部分更新优化

```java
// Producer 只关注需要的 Topic
private final Set<String> newTopics;

// 添加新 Topic 时触发更新
public synchronized void add(String topic) {
    Objects.requireNonNull(topic, "topic cannot be null");
    if (newTopics.add(topic)) {
        requestUpdate();
    }
}

// MetadataRequest 只请求需要的 Topic
public MetadataRequest(List<String> topics, boolean allowAutoTopicCreation) {
    this.topics = topics;  // 只获取这些 Topic 的元数据
    this.allowAutoTopicCreation = allowAutoTopicCreation;
}
```

---

## 5. 分区信息发现

### 5.1 分区数变化处理

```java
// 检查分区数量是否变化
public synchronized int partitionCountForTopic(String topic) {
    Cluster cluster = this.cluster;
    List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
    return partitions != null ? partitions.size() : null;
}

// 使用场景：分区器计算目标分区
int partition = partitioner.partition(
    topic, key, keyBytes, value, valueBytes, cluster
);
```

### 5.2 Leader 变更处理

```java
// 当收到 NOT_LEADER_OR_FOLLOWER 错误时
private void handleError(ProducerBatch batch, Errors error) {
    if (error == Errors.NOT_LEADER_OR_FOLLOWER ||
        error == Errors.LEADER_NOT_AVAILABLE) {

        // 1. 标记需要更新元数据
        metadata.requestUpdate();

        // 2. 重新入队等待重试
        batch.requeue();
    }
}
```

**Leader 变更流程**：

```
1. Producer 发送消息到 Leader (Broker 1)
         │
         ▼
2. Broker 1 不再是 Leader，返回 NOT_LEADER_OR_FOLLOWER
         │
         ▼
3. Producer 触发元数据更新
         │
         ▼
4. 获取新的 Leader 信息 (Broker 2)
         │
         ▼
5. 重试发送消息到 Broker 2
```

### 5.3 新 Topic 自动发现

```java
// 发送消息时自动添加 Topic
public Future<RecordMetadata> send(ProducerRecord<K, V> record, Callback callback) {
    // 检查是否需要添加 Topic 到元数据
    if (metadata.fetch().partitionsForTopic(record.topic()) == null) {
        metadata.add(record.topic());
    }
    // ...
}

// 自动创建 Topic 配置
props.put("allow.auto.create.topics", "true");  // 默认 true
```

**新 Topic 发现流程**：

```java
// 1. 第一次发送到新 Topic
producer.send(new ProducerRecord<>("new-topic", "key", "value"));

// 2. 添加到 newTopics 集合
metadata.add("new-topic");  // 触发 needUpdate = true

// 3. Sender 线程检测到需要更新
void runOnce() {
    if (metadata.updateRequested()) {
        // 发送 MetadataRequest
    }
}

// 4. 获取元数据后，了解分区数
Cluster cluster = metadata.fetch();
List<PartitionInfo> partitions = cluster.partitionsForTopic("new-topic");
int numPartitions = partitions.size();  // 获取分区数量
```

### 5.4 元数据缓存与分区器协作

```java
// 分区器使用元数据计算分区
public class DefaultPartitioner implements Partitioner {
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();

        if (keyBytes == null) {
            // 无 key 时使用粘性分区
            return stickyPartition(topic, numPartitions);
        }

        // 有 key 时根据 key hash 选择分区
        return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
    }
}
```

---

**上一章**: [03. Sender 线程详解](./03-sender-thread.md)
**下一章**: [05. 分区器详解](./05-partitioner.md)
