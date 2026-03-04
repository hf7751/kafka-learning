# 03. ConsumerCoordinator 消费组协调器

本文档深入分析 Kafka Consumer 的消费组协调机制，了解 Consumer 如何加入消费组、进行分区分配和维持组成员身份。

## 目录
- [1. ConsumerCoordinator 概述](#1-consumercoordinator-概述)
- [2. 加入消费组流程](#2-加入消费组流程)
- [3. 分区分配机制](#3-分区分配机制)
- [4. 重平衡 (Rebalance) 机制](#4-重平衡-rebalance-机制)
- [5. Offset 提交管理](#5-offset-提交管理)
- [6. 心跳管理](#6-心跳管理)

---

## 1. ConsumerCoordinator 概述

### 1.1 Coordinator 的职责

ConsumerCoordinator 负责管理 Consumer 与消费组的协调工作：

| 职责 | 说明 |
|-----|------|
| **发现 Coordinator** | 查找负责该消费组的 GroupCoordinator |
| **加入消费组** | 执行 JoinGroup + SyncGroup 协议 |
| **心跳维护** | 定期发送心跳维持组成员身份 |
| **分区分配** | Leader Consumer 执行分区分配计算 |
| **Offset 管理** | 提交和获取消费位移 |
| **重平衡处理** | 响应消费组成员变化 |

### 1.2 继承关系

```
┌─────────────────────────────────────────────────────────────────┐
│                    AbstractCoordinator                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  通用协调功能                                             │   │
│  │  - 状态管理                                               │   │
│  │  - 心跳线程                                               │   │
│  │  - 请求队列                                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ 继承                              │
│                              ▼                                  │
│                    ┌──────────────────┐                        │
│                    │ ConsumerCoordinator │                       │
│                    │  消费者特定功能      │                       │
│                    │  - 订阅管理         │                       │
│                    │  - 分区分配         │                       │
│                    │  - Offset 提交      │                       │
│                    └──────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 关键字段

```java
public final class ConsumerCoordinator extends AbstractCoordinator {
    // 订阅状态管理
    private final SubscriptionState subscriptions;

    // 分区分配策略
    private final List<ConsumerPartitionAssignor> assignors;

    // 元数据管理
    private final ConsumerMetadata metadata;

    // 是否需要重加入（分区分配策略不匹配）
    private boolean rejoinNeeded;

    // 是否需要更新分区分配
    private volatile boolean assignmentSnapshot;

    // 消费组中的 Leader
    private boolean isLeader;

    // 分配的 Partition 列表
    private List<TopicPartition> assignedPartitions;

    // 自动提交配置
    private final boolean autoCommitEnabled;
    private final int autoCommitIntervalMs;
    private volatile long nextAutoCommitDeadline;
}
```

---

## 2. 加入消费组流程

### 2.1 FindCoordinator 请求

```java
/**
 * 查找 GroupCoordinator
 */
protected synchronized Node coordinator() {
    if (coordinator != null) {
        return coordinator;
    }

    // 发送 FindCoordinator 请求
    FindCoordinatorRequest.Builder requestBuilder =
        new FindCoordinatorRequest.Builder(
            FindCoordinatorRequest.CoordinatorType.GROUP,
            groupId
        );

    // 选择 least loaded node 发送请求
    Node node = client.leastLoadedNode();
    if (node == null) {
        throw new CoordinatorNotAvailableException("No available node");
    }

    ClientRequest request = client.newClientRequest(
        node.idString(),
        requestBuilder,
        time.milliseconds(),
        true,
        new FindCoordinatorCallback()
    );

    client.send(request, time.milliseconds());
    return null;
}

/**
 * FindCoordinator 响应处理
 */
private class FindCoordinatorCallback implements RequestFutureListener<ClientResponse> {
    @Override
    public void onSuccess(ClientResponse response) {
        FindCoordinatorResponse findCoordinatorResponse =
            (FindCoordinatorResponse) response.responseBody();

        Errors error = findCoordinatorResponse.error();
        if (error == Errors.NONE) {
            // 获取 Coordinator 节点
            coordinator = new Node(
                Node.NO_NODE_ID,
                findCoordinatorResponse.data().host(),
                findCoordinatorResponse.data().port()
            );
            log.info("Discovered group coordinator {}", coordinator);
        } else {
            handleFindCoordinatorError(error);
        }
    }
}
```

### 2.2 JoinGroup 请求详解

```java
/**
 * 发送 JoinGroup 请求
 */
private synchronized RequestFuture<ByteBuffer> sendJoinGroupRequest() {
    if (coordinatorUnknown()) {
        return RequestFuture.coordinatorNotAvailable();
    }

    // 构建 JoinGroup 请求
    JoinGroupRequest.Builder requestBuilder = new JoinGroupRequest.Builder(
        new JoinGroupRequestData()
            .setGroupId(groupId)
            .setSessionTimeoutMs(sessionTimeoutMs)
            .setRebalanceTimeoutMs(rebalanceTimeoutMs)
            .setMemberId(memberId)
            .setGroupInstanceId(groupInstanceId.orElse(null))
            .setProtocolType(PROTOCOL_TYPE)
            .setProtocols(metadata())
    );

    log.debug("Sending JoinGroup request to coordinator {}: {}", coordinator, requestBuilder);

    return client.send(coordinator, requestBuilder)
        .compose(new JoinGroupResponseHandler());
}

/**
 * 构建元数据（支持的分配策略）
 */
private List<JoinGroupRequestData.JoinGroupRequestProtocol> metadata() {
    List<JoinGroupRequestData.JoinGroupRequestProtocol> protocols = new ArrayList<>();

    for (ConsumerPartitionAssignor assignor : assignors) {
        // 获取订阅信息
        Subscription subscription = new Subscription(
            new ArrayList<>(subscriptions.subscription()),
            subscriptions.assignedPartitions()
        );

        ByteBuffer metadata = ConsumerProtocol.serializeSubscription(subscription);
        protocols.add(new JoinGroupRequestData.JoinGroupRequestProtocol()
            .setName(assignor.name())
            .setMetadata(metadata.array())
        );
    }

    return protocols;
}
```

### 2.3 SyncGroup 请求详解

```java
/**
 * 发送 SyncGroup 请求
 */
private synchronized RequestFuture<ByteBuffer> sendSyncGroupRequest(
        JoinGroupResponse joinResponse,
        Map<String, ByteBuffer> groupAssignment) {

    SyncGroupRequest.Builder requestBuilder = new SyncGroupRequest.Builder(
        new SyncGroupRequestData()
            .setGroupId(groupId)
            .setMemberId(memberId)
            .setGroupInstanceId(groupInstanceId.orElse(null))
            .setGenerationId(joinResponse.data().generationId())
            .setProtocolType(joinResponse.data().protocolType())
            .setProtocolName(joinResponse.data().protocolName())
            .setAssignments(groupAssignment.entrySet().stream()
                .map(entry -> new SyncGroupRequestData.SyncGroupRequestAssignment()
                    .setMemberId(entry.getKey())
                    .setAssignment(Utils.toArray(entry.getValue())))
                .collect(Collectors.toList()))
    );

    log.debug("Sending SyncGroup request to coordinator {}: {}", coordinator, requestBuilder);

    return client.send(coordinator, requestBuilder)
        .compose(new SyncGroupResponseHandler());
}
```

### 2.4 成员身份维护

```java
/**
 * 成员状态
 */
private enum MemberState {
    UNJOINED,       // 未加入
    REBALANCING,    // 重平衡中
    STABLE          // 稳定状态
}

private MemberState state = MemberState.UNJOINED;
private String memberId = JoinGroupRequest.UNKNOWN_MEMBER_ID;
private int generation = Generation.NO_GENERATION.generationId;

/**
 * 判断是否已加入消费组
 */
public synchronized boolean hasStableGeneration() {
    return state == MemberState.STABLE && generation > Generation.NO_GENERATION.generationId;
}

/**
 * 获取当前世代号
 */
public synchronized int generation() {
    return generation;
}
```

---

## 3. 分区分配机制

### 3.1 分配策略概述

```
分区分配流程：

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   消费者 A   │     │   消费者 B   │     │   消费者 C   │
│  (Leader)   │     │             │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │   JoinGroup       │   JoinGroup       │   JoinGroup
       └───────────────────┼───────────────────┘
                           ▼
                    ┌─────────────┐
                    │ Coordinator │
                    │             │
                    │ 1. 收集所有 │
                    │    成员信息 │
                    │ 2. 选举 Leader│
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │   JoinGroup Resp  │   JoinGroup Resp  │   JoinGroup Resp
       │   (Leader)        │   (Follower)      │   (Follower)
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ 1. 执行分配  │     │ 等待分配     │     │ 等待分配     │
│ 2. SyncGroup │     │             │     │             │
└──────┬──────┘     └─────────────┘     └─────────────┘
       │
       │   SyncGroup (包含分配结果)
       └──────────────────────────────────────────────▶
                           │
                    ┌─────────────┐
                    │ Coordinator │
                    │             │
                    │ 分发分配结果│
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ 获得分区分配 │     │ 获得分区分配 │     │ 获得分区分配 │
│ [tp0, tp1]  │     │ [tp2, tp3]  │     │ [tp4, tp5]  │
└─────────────┘     └─────────────┘     └─────────────┘
```

### 3.2 客户端分配 vs 服务端分配

```java
/**
 * Consumer 端的分配计算（Leader Consumer 执行）
 */
private Map<String, ByteBuffer> performAssignment(
        String protocolName,
        Map<String, JoinGroupResponseMember> allMemberMetadata) {

    // 查找对应的分配策略
    ConsumerPartitionAssignor assignor = lookupAssignor(protocolName);
    if (assignor == null) {
        throw new IllegalStateException("No matching assignor for protocol: " + protocolName);
    }

    log.debug("Performing assignment using strategy {} with members {}",
        assignor.name(), allMemberMetadata.keySet());

    // 反序列化每个成员的订阅信息
    Map<String, Subscription> subscriptions = new HashMap<>();
    for (Map.Entry<String, JoinGroupResponseMember> entry : allMemberMetadata.entrySet()) {
        Subscription subscription = ConsumerProtocol.deserializeSubscription(
            ByteBuffer.wrap(entry.getValue().metadata())
        );
        subscriptions.put(entry.getKey(), subscription);
    }

    // 获取每个 Topic 的分区数
    Map<String, Integer> partitionsPerTopic = new HashMap<>();
    for (String topic : subscriptions.values().stream()
            .flatMap(s -> s.topics().stream())
            .collect(Collectors.toSet())) {
        Integer numPartitions = metadata.fetch().partitionCountForTopic(topic);
        if (numPartitions != null) {
            partitionsPerTopic.put(topic, numPartitions);
        }
    }

    // 执行分配
    Map<String, Assignment> assignment = assignor.assign(
        partitionsPerTopic,
        subscriptions
    );

    // 序列化分配结果
    Map<String, ByteBuffer> groupAssignment = new HashMap<>();
    for (Map.Entry<String, Assignment> memberAssignment : assignment.entrySet()) {
        ByteBuffer buffer = ConsumerProtocol.serializeAssignment(memberAssignment.getValue());
        groupAssignment.put(memberAssignment.getKey(), buffer);
    }

    return groupAssignment;
}
```

### 3.3 PartitionAssignor 接口

```java
/**
 * 分区分配策略接口
 */
public interface ConsumerPartitionAssignor {

    /**
     * 执行分区分配
     *
     * @param partitionsPerTopic Topic -> 分区数的映射
     * @param subscriptions      Consumer ID -> 订阅信息的映射
     * @return Consumer ID -> 分配结果的映射
     */
    Map<String, Assignment> assign(
        Map<String, Integer> partitionsPerTopic,
        Map<String, Subscription> subscriptions
    );

    /**
     * 返回分配策略名称
     */
    String name();

    /**
     * 订阅信息
     */
    class Subscription {
        private final List<String> topics;
        private final ByteBuffer userData;
        private final List<TopicPartition> ownedPartitions;
    }

    /**
     * 分配结果
     */
    class Assignment {
        private final List<TopicPartition> partitions;
        private final ByteBuffer userData;
    }
}
```

### 3.4 分配结果处理

```java
/**
 * 处理 SyncGroup 响应，应用分配结果
 */
private void onJoinComplete(int generation,
                            String memberId,
                            String protocol,
                            ByteBuffer assignmentBuffer) {
    // 反序列化分配结果
    Assignment assignment = ConsumerProtocol.deserializeAssignment(assignmentBuffer);
    List<TopicPartition> assignedPartitions = assignment.partitions();

    log.debug("Joined group: generation={}, memberId={}, assignedPartitions={}",
        generation, memberId, assignedPartitions);

    // 检查分区变化
    Set<TopicPartition> addedPartitions = new HashSet<>(assignedPartitions);
    addedPartitions.removeAll(this.assignedPartitions);

    Set<TopicPartition> revokedPartitions = new HashSet<>(this.assignedPartitions);
    revokedPartitions.removeAll(assignedPartitions);

    // 触发再均衡监听器
    if (!revokedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsRevoked(revokedPartitions);
    }

    // 更新分配
    this.generation = generation;
    this.memberId = memberId;
    this.assignedPartitions = assignedPartitions;
    subscriptions.assignFromSubscribed(assignedPartitions);

    // 触发分配完成监听
    if (!addedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsAssigned(addedPartitions);
    }
}
```

---

## 4. 重平衡 (Rebalance) 机制

### 4.1 重平衡触发条件

| 触发条件 | 说明 |
|---------|------|
| **新成员加入** | 新 Consumer 加入消费组 |
| **成员离开** | Consumer 主动离开或心跳超时 |
| **订阅变化** | Consumer 订阅的 Topic 列表变化 |
| **分区变化** | Topic 分区数增加 |
| **Coordinator 变更** | GroupCoordinator 发生变化 |
| **成员提交失败** | Offset 提交失败导致重新加入 |

### 4.2 重平衡协议

```
Eager Rebalance 流程（Kafka < 2.4）：

Consumer A                    Consumer B                   Coordinator
    │                             │                             │
    │   JoinGroup (member=A)      │   JoinGroup (member=B)      │
    └─────────────────────────────┼────────────────────────────▶│
                                  │                             │
                                  │                             │ 1. 收集成员
                                  │                             │ 2. 选举 Leader
                                  │                             │
    │   JoinGroup Resp (Leader)   │   JoinGroup Resp            │
    │◀────────────────────────────┼─────────────────────────────│
    │                             │                             │
    │                             │   SyncGroup                 │
    │   SyncGroup (assignment)    │   (wait for assignment)     │
    └─────────────────────────────┼────────────────────────────▶│
                                  │                             │
                                  │                             │ 3. Leader 分配
                                  │                             │
    │                             │   SyncGroup Resp            │
    │                             │◀────────────────────────────│
    │   SyncGroup Resp            │                             │
    │◀────────────────────────────┼─────────────────────────────│

问题：
- 所有 Consumer 在 Rebalance 期间停止消费
- 大量分区时 Rebalance 时间长
```

### 4.3 重平衡流程详解

```java
/**
 * 执行重平衡
 */
public boolean poll(Timer timer, boolean waitForJoinGroup) {
    // 1. 确保 Coordinator 已知
    if (coordinatorUnknown()) {
        if (!ensureCoordinatorReady(timer)) {
            return false;
        }
    }

    // 2. 确保加入消费组
    if (rejoinNeededOrPending()) {
        // 执行再平衡
        if (!ensureActiveGroup(timer)) {
            return false;
        }
    }

    // 3. 执行周期性任务
    maybeAutoCommitOffsetsAsync(timer.currentTimeMs());

    return true;
}

/**
 * 判断是否需要重新加入
 */
private synchronized boolean rejoinNeededOrPending() {
    // 未加入或需要重新加入
    return !hasStableGeneration() || rejoinNeeded || !assignmentSnapshot;
}

/**
 * 加入消费组（包含重平衡逻辑）
 */
private boolean ensureActiveGroup(final Timer timer) {
    // 确保不持有任何分区
    if (!hasStableGeneration()) {
        // 触发分区撤销回调
        subscriptions.rebalanceListener().onPartitionsRevoked(
            subscriptions.assignedPartitions()
        );
    }

    // 发送 JoinGroup 请求
    RequestFuture<ByteBuffer> future = sendJoinGroupRequest();

    // 等待响应
    client.poll(future, timer);

    if (future.succeeded()) {
        // 处理分配结果
        ByteBuffer assignment = future.value();
        onJoinComplete(generation, memberId, protocol, assignment);
        return true;
    } else {
        // 处理错误
        handleJoinGroupError(future.exception());
        return false;
    }
}
```

### 4.4 Cooperative Rebalance（增量重平衡）

```java
/**
 * Cooperative Rebalance 流程（Kafka 2.4+）
 *
 * 特点：分阶段回收和分配分区，减少消费停顿
 */

// 第一阶段：只回收需要重新分配的分区
private void onJoinPrepare(int generation, String memberId) {
    // 只撤销需要重新分配的分区，保留大部分分区继续消费
    Set<TopicPartition> revokedPartitions =
        getPartitionsNeedingRevocation(assignment, newAssignment);

    if (!revokedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsRevoked(revokedPartitions);
    }
}

// 第二阶段：分配新分区
private void onJoinComplete(int generation, String memberId, String protocol,
                           ByteBuffer assignmentBuffer) {
    Assignment assignment = ConsumerProtocol.deserializeAssignment(assignmentBuffer);

    // 只处理新增的分区
    Set<TopicPartition> addedPartitions = new HashSet<>(assignment.partitions());
    addedPartitions.removeAll(currentAssignment);

    subscriptions.assignFromSubscribed(assignment.partitions());

    if (!addedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsAssigned(addedPartitions);
    }
}
```

---

## 5. Offset 提交管理

### 5.1 commitSync() 流程

```java
/**
 * 同步提交 Offset
 */
public boolean commitSync(final Map<TopicPartition, OffsetAndMetadata> offsets,
                          final Timer timer) {
    // 确保已加入消费组
    if (!ensureCoordinatorReady(timer)) {
        return false;
    }

    // 发送 OffsetCommit 请求
    RequestFuture<Void> future = sendOffsetCommitRequest(offsets);

    // 等待响应
    client.poll(future, timer);

    if (future.succeeded()) {
        // 更新本地缓存
        offsets.forEach((tp, offset) -> subscriptions.committed(tp, offset));
        return true;
    } else {
        throw future.exception();
    }
}

/**
 * 构建 OffsetCommit 请求
 */
private RequestFuture<Void> sendOffsetCommitRequest(
        final Map<TopicPartition, OffsetAndMetadata> offsets) {

    if (offsets.isEmpty()) {
        return RequestFuture.voidSuccess();
    }

    OffsetCommitRequest.Builder requestBuilder = new OffsetCommitRequest.Builder(
        new OffsetCommitRequestData()
            .setGroupId(groupId)
            .setMemberId(memberId)
            .setGenerationId(generation)
            .setTopics(offsets.entrySet().stream()
                .collect(Collectors.groupingBy(
                    e -> e.getKey().topic(),
                    Collectors.mapping(e -> new OffsetCommitRequestData.OffsetCommitRequestPartition()
                        .setPartitionIndex(e.getKey().partition())
                        .setCommittedOffset(e.getValue().offset())
                        .setCommittedLeaderEpoch(e.getValue().leaderEpoch().orElse(-1))
                        .setCommittedMetadata(e.getValue().metadata())
                        .setCommitTimestamp(time.milliseconds())
                    , Collectors.toList())
                ))
                .entrySet().stream()
                .map(e -> new OffsetCommitRequestData.OffsetCommitRequestTopic()
                    .setName(e.getKey())
                    .setPartitions(e.getValue()))
                .collect(Collectors.toList()))
    );

    return client.send(coordinator, requestBuilder)
        .compose(new OffsetCommitResponseHandler(offsets));
}
```

### 5.2 commitAsync() 流程

```java
/**
 * 异步提交 Offset
 */
public void commitAsync(final Map<TopicPartition, OffsetAndMetadata> offsets,
                        final OffsetCommitCallback callback) {
    if (coordinatorUnknown()) {
        // Coordinator 未知，立即失败
        callback.onComplete(offsets, new CoordinatorNotAvailableException());
        return;
    }

    // 发送异步请求
    RequestFuture<Void> future = sendOffsetCommitRequest(offsets);

    // 添加回调
    future.addListener(new RequestFutureListener<Void>() {
        @Override
        public void onSuccess(Void value) {
            callback.onComplete(offsets, null);
        }

        @Override
        public void onFailure(RuntimeException e) {
            callback.onComplete(offsets, e);
        }
    });
}
```

### 5.3 Offset 提交请求构建

```java
/**
 * OffsetAndMetadata 结构
 */
public class OffsetAndMetadata {
    private final long offset;              // 提交的 Offset
    private final Optional<String> leaderEpoch;  // Leader Epoch
    private final String metadata;          // 元数据（自定义）

    public OffsetAndMetadata(long offset, String metadata) {
        this(offset, Optional.empty(), metadata);
    }
}

/**
 * 自动提交逻辑
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

        // 异步提交
        commitAsync(offsets, (committedOffsets, exception) -> {
            if (exception != null) {
                log.warn("Auto offset commit failed", exception);
            }
        });

        nextAutoCommitDeadline = now + autoCommitIntervalMs;
    }
}
```

### 5.4 提交失败处理

```java
/**
 * OffsetCommit 响应处理
 */
private class OffsetCommitResponseHandler extends CoordinatorResponseHandler<OffsetCommitResponse, Void> {

    private final Map<TopicPartition, OffsetAndMetadata> offsets;

    @Override
    public void handle(OffsetCommitResponse response, RequestFuture<Void> future) {
        Map<TopicPartition, Errors> errors = response.errors();

        for (Map.Entry<TopicPartition, Errors> entry : errors.entrySet()) {
            TopicPartition tp = entry.getKey();
            Errors error = entry.getValue();

            if (error == Errors.NONE) {
                log.debug("Committed offset {} for partition {}",
                    offsets.get(tp).offset(), tp);
            } else {
                handleCommitError(tp, error, future);
            }
        }
    }

    private void handleCommitError(TopicPartition tp, Errors error, RequestFuture<Void> future) {
        switch (error) {
            case COORDINATOR_LOAD_IN_PROGRESS:
            case COORDINATOR_NOT_AVAILABLE:
                // 临时错误，可重试
                future.raise(error.exception());
                break;

            case UNKNOWN_TOPIC_OR_PARTITION:
            case TOPIC_AUTHORIZATION_FAILED:
                // 不可重试错误
                future.raise(new KafkaException("Commit failed for " + tp + ": " + error));
                break;

            case REBALANCE_IN_PROGRESS:
            case ILLEGAL_GENERATION:
            case UNKNOWN_MEMBER_ID:
                // 需要重新加入消费组
                resetGeneration();
                future.raise(error.exception());
                break;

            default:
                future.raise(new KafkaException("Unexpected error committing offset: " + error));
        }
    }
}
```

---

## 6. 心跳管理

### 6.1 心跳线程

```java
/**
 * 心跳任务
 */
private class HeartbeatThread implements Runnable {

    private boolean enabled = false;

    public void run() {
        while (true) {
            synchronized (AbstractCoordinator.this) {
                if (closed) {
                    return;
                }

                if (!enabled) {
                    try {
                        AbstractCoordinator.this.wait();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }

                if (coordinatorUnknown()) {
                    continue;
                }

                // 检查是否需要发送心跳
                if (heartbeat.sessionTimeoutExpired(now)) {
                    // 会话超时，标记需要重新加入
                    markCoordinatorUnknown();
                    continue;
                }

                if (!heartbeat.shouldHeartbeat(now)) {
                    // 还没到发送时间
                    AbstractCoordinator.this.wait(
                        heartbeat.timeToNextHeartbeat(now));
                    continue;
                }
            }

            // 发送心跳
            sendHeartbeatRequest();
        }
    }
}

/**
 * 发送心跳请求
 */
synchronized RequestFuture<Void> sendHeartbeatRequest() {
    if (coordinatorUnknown()) {
        return RequestFuture.coordinatorNotAvailable();
    }

    log.debug("Sending Heartbeat request to coordinator {} with generation {}",
        coordinator, generation);

    HeartbeatRequest.Builder requestBuilder = new HeartbeatRequest.Builder(
        new HeartbeatRequestData()
            .setGroupId(groupId)
            .setMemberId(memberId)
            .setGroupInstanceId(groupInstanceId.orElse(null))
            .setGenerationId(generation)
    );

    return client.send(coordinator, requestBuilder)
        .compose(new HeartbeatResponseHandler());
}
```

### 6.2 心跳间隔与会话超时

```java
/**
 * 心跳状态管理
 */
public class Heartbeat {
    private final int sessionTimeoutMs;      // 会话超时时间
    private final int heartbeatIntervalMs;   // 心跳间隔
    private final int maxPollIntervalMs;     // 最大轮询间隔

    private long lastHeartbeatSend = 0;      // 上次发送时间
    private long lastHeartbeatReceive = 0;   // 上次接收时间
    private long lastPoll = 0;               // 上次 poll 时间

    /**
     * 是否应该发送心跳
     */
    public boolean shouldHeartbeat(long now) {
        return now - lastHeartbeatSend >= heartbeatIntervalMs;
    }

    /**
     * 会话是否超时
     */
    public boolean sessionTimeoutExpired(long now) {
        return now - lastHeartbeatReceive > sessionTimeoutMs;
    }

    /**
     * poll 是否超时
     */
    public boolean pollTimeoutExpired(long now) {
        return now - lastPoll > maxPollIntervalMs;
    }

    /**
     * 距离下次心跳的时间
     */
    public long timeToNextHeartbeat(long now) {
        return Math.max(0, heartbeatIntervalMs - (now - lastHeartbeatSend));
    }
}
```

### 6.3 心跳失败处理

```java
/**
 * 心跳响应处理
 */
private class HeartbeatResponseHandler extends CoordinatorResponseHandler<HeartbeatResponse, Void> {

    @Override
    public void handle(HeartbeatResponse response, RequestFuture<Void> future) {
        sensors.heartbeatSensor.record(response.requestLatencyMs());

        Errors error = response.error();
        if (error == Errors.NONE) {
            log.debug("Received successful Heartbeat response");
            future.complete(null);
        } else {
            handleHeartbeatError(error, future);
        }
    }

    private void handleHeartbeatError(Errors error, RequestFuture<Void> future) {
        switch (error) {
            case REBALANCE_IN_PROGRESS:
                // 正在重平衡，需要重新加入
                rejoinNeeded = true;
                future.raise(new RebalanceInProgressException());
                break;

            case ILLEGAL_GENERATION:
                // 世代号过期，需要重新加入
                resetGeneration();
                future.raise(error.exception());
                break;

            case UNKNOWN_MEMBER_ID:
                // 成员 ID 未知，重置后重新加入
                memberId = JoinGroupRequest.UNKNOWN_MEMBER_ID;
                resetGeneration();
                future.raise(error.exception());
                break;

            case GROUP_AUTHORIZATION_FAILED:
                future.raise(new GroupAuthorizationException(groupId));
                break;

            default:
                future.raise(new KafkaException("Unexpected error in heartbeat: " + error));
        }
    }
}
```

### 6.4 离开消费组

```java
/**
 * 离开消费组（优雅退出）
 */
public synchronized void leaveGroup() {
    if (memberId == JoinGroupRequest.UNKNOWN_MEMBER_ID) {
        return;
    }

    log.debug("Leaving group with memberId {}", memberId);

    LeaveGroupRequest.Builder requestBuilder = new LeaveGroupRequest.Builder(
        new LeaveGroupRequestData()
            .setGroupId(groupId)
            .setMemberId(memberId)
            .setGroupInstanceId(groupInstanceId.orElse(null))
            .setMembers(Collections.emptyList())
    );

    // 同步发送离开请求
    client.send(coordinator, requestBuilder).compose(
        new LeaveGroupResponseHandler()
    );

    // 重置状态
    resetGeneration();
    memberId = JoinGroupRequest.UNKNOWN_MEMBER_ID;
}

/**
 * 重置世代信息
 */
protected synchronized void resetGeneration() {
    this.generation = Generation.NO_GENERATION;
    this.memberId = JoinGroupRequest.UNKNOWN_MEMBER_ID;
    this.rejoinNeeded = true;
}
```

---

**上一章**: [02. Fetcher 拉取机制](./02-fetcher-mechanism.md)
**下一章**: [04. 分区分配策略详解](./04-partition-assignor.md)
