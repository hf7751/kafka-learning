# 05. Consumer Rebalance 重平衡详解

本文档深入分析 Kafka Consumer 的重平衡机制，了解重平衡的触发条件、流程和优化策略。

## 目录
- [1. 重平衡概述](#1-重平衡概述)
- [2. 重平衡触发条件](#2-重平衡触发条件)
- [3. 重平衡协议演进](#3-重平衡协议演进)
- [4. Eager Rebalance 流程](#4-eager-rebalance-流程)
- [5. Cooperative Rebalance 流程](#5-cooperative-rebalance-流程)
- [6. 重平衡性能优化](#6-重平衡性能优化)

---

## 1. 重平衡概述

### 1.1 什么是重平衡

重平衡（Rebalance）是 Kafka Consumer Group 的核心机制，用于在消费组成员变化时重新分配分区：

```
重平衡的本质：

消费组状态：                  重平衡后状态：
┌─────────────┐              ┌─────────────┐
│ Consumer A  │──────┐       │ Consumer A  │──────┐
│  [tp0, tp1] │      │       │  [tp0, tp1] │      │
└─────────────┘      │       │   [tp2]     │      │
                     │       └─────────────┘      │
┌─────────────┐      │                            │
│ Consumer B  │──────┼─────▶  Consumer B  ────────┤
│  [tp2, tp3] │      │       │  [tp3, tp4] │      │
└─────────────┘      │       └─────────────┘      │
                     │                            │
                     │       ┌─────────────┐      │
                     │       │ Consumer C  │──────┘
                     │       │  (new)      │
                     │       └─────────────┘
                     │
                新增 Consumer C
                触发重平衡
                重新分配所有分区
```

### 1.2 重平衡的必要性

| 场景 | 说明 |
|-----|------|
| **故障恢复** | Consumer 故障时，其分区分配给其他 Consumer |
| **扩容缩容** | 动态增减 Consumer 调整消费能力 |
| **分区调整** | Topic 分区数变化时重新分配 |
| **订阅变更** | 消费组订阅的 Topic 列表变化 |

### 1.3 重平衡的代价

```
重平衡的成本：

1. 停止消费
   - 所有 Consumer 放弃当前分区
   - 消费停顿时间 = Rebalance 时间

2. 状态丢失
   - 未提交的 Offset 可能丢失
   - 缓存数据需要重建

3. 重复消费
   - 新分配可能从已消费位置开始
   - 取决于 Offset 提交时机

4. 网络开销
   - JoinGroup/SyncGroup 请求
   - 元数据同步
```

---

## 2. 重平衡触发条件

### 2.1 消费者加入

```java
/**
 * 新 Consumer 加入消费组触发重平衡
 */
public void subscribe(Collection<String> topics) {
    // 1. 更新订阅
    subscriptions.subscribe(new HashSet<>(topics), rebalanceListener);

    // 2. 标记需要重新加入
    metadata.setTopics(subscriptions.groupSubscription());

    // 3. 触发 Rebalance
    rejoinNeeded = true;
}

/**
 * GroupCoordinator 处理新成员加入
 */
private void addMemberAndRebalance(String groupId, String memberId) {
    GroupMetadata group = groupMetadataCache.get(groupId);

    // 添加新成员
    group.add(memberId, memberMetadata);

    // 触发重平衡
    group.transitionTo(PREPARING_REBALANCE);
    scheduleRebalance(group);
}
```

### 2.2 消费者离开

```java
/**
 * 消费者主动离开
 */
public void close() {
    if (coordinator != null) {
        // 发送 LeaveGroup 请求
        coordinator.leaveGroup();
    }
}

/**
 * 消费者心跳超时
 */
private void onHeartbeatTimeout(String memberId) {
    GroupMetadata group = getGroup(memberId);

    // 移除超时成员
    group.remove(memberId);

    // 触发重平衡
    if (group.isInState(STABLE)) {
        group.transitionTo(PREPARING_REBALANCE);
        scheduleRebalance(group);
    }
}

/**
 * 消费者 poll 超时
 */
public boolean pollTimeoutExpired(long now) {
    return now - lastPollTime > maxPollIntervalMs;
}
```

### 2.3 主题分区变化

```java
/**
 * Topic 分区数增加时触发
 */
private void onPartitionCountChanged(String topic, int newPartitionCount) {
    for (GroupMetadata group : groupsForTopic(topic)) {
        // 检查是否需要重平衡
        if (group.subscribesTo(topic)) {
            group.transitionTo(PREPARING_REBALANCE);
            scheduleRebalance(group);
        }
    }
}
```

### 2.4 订阅变化

```java
/**
 * 消费者修改订阅列表
 */
public void subscribe(Pattern pattern, ConsumerRebalanceListener listener) {
    // 订阅模式匹配多个 Topic
    subscriptions.subscribe(pattern, listener);

    // 发现新的匹配 Topic
    Set<String> newTopics = metadata.fetch().topics().stream()
        .filter(topic -> pattern.matches(topic))
        .collect(Collectors.toSet());

    if (!newTopics.equals(currentSubscription)) {
        // 订阅变化，触发重平衡
        rejoinNeeded = true;
    }
}
```

---

## 3. 重平衡协议演进

### 3.1 Eager Rebalance (Kafka < 2.4)

```
Eager Rebalance 特点：

1. 立即停止消费
   - Consumer 收到 REBALANCE_IN_PROGRESS 错误
   - 立即放弃所有分区

2. 全量重新分配
   - 不考虑之前的分配结果
   - 所有分区重新计算

3. 单阶段完成
   - JoinGroup + SyncGroup
   - 一次性完成分配

缺点：
- 重平衡期间全组停止消费
- 大量分区时停顿时间长
- 频繁 Rebalance 影响大
```

### 3.2 Static Membership (Kafka 2.3+)

```java
/**
 * 静态成员配置
 * 使用固定的 group.instance.id，重启后保持分区分配
 */
props.put("group.instance.id", "consumer-instance-1");

/**
 * Static Membership 原理：
 *
 * 传统方式（动态成员）：
 * Consumer 重启 → 新 memberId → 触发 Rebalance → 重新分配分区
 *
 * 静态成员：
 * Consumer 重启 → 相同 group.instance.id → Coordinator 识别 →
 * 保持原有分区分配 → 不触发 Rebalance（在 session.timeout.ms 内）
 */

/**
 * GroupCoordinator 处理静态成员加入
 */
private void maybeReplaceStaticMember(String groupId,
                                       String groupInstanceId,
                                       String newMemberId) {
    GroupMetadata group = groupMetadataCache.get(groupId);

    // 查找是否有相同 instance.id 的旧成员
    String oldMemberId = group.staticMemberId(groupInstanceId);

    if (oldMemberId != null) {
        // 替换旧成员，保持分区分配
        group.replaceMember(oldMemberId, newMemberId);

        // 不触发重平衡（如果在超时时间内）
        if (!group.hasMemberTimedOut(oldMemberId)) {
            return;  // 直接返回，不触发 Rebalance
        }
    }

    // 触发正常重平衡
    group.transitionTo(PREPARING_REBALANCE);
}
```

### 3.3 Cooperative Rebalance (Kafka 2.4+)

```
Cooperative Rebalance 特点：

1. 两阶段协议
   - 阶段一：只放弃需要重新分配的分区
   - 阶段二：分配新分区

2. 增量重平衡
   - 大部分分区继续消费
   - 最小化消费停顿

3. 与 Eager 兼容
   - 渐进式升级
   - 混合协议支持
```

---

## 4. Eager Rebalance 流程

### 4.1 第一阶段：Revoke

```java
/**
 * 放弃分区前的准备
 */
private void onJoinPrepare(int generation, String memberId) {
    log.debug("Executing onJoinPrepare with generation {} and memberId {}",
        generation, memberId);

    // 1. 禁用心跳线程
    heartbeatThread.disable();

    // 2. 等待完成待处理的请求
    pendingRequests.await();

    // 3. 触发分区撤销回调
    Set<TopicPartition> revokedPartitions = new HashSet<>(
        subscriptions.assignedPartitions()
    );

    if (!revokedPartitions.isEmpty()) {
        log.info("Giving away all assigned partitions as {}",
            isLeader ? "leader" : "follower");

        // 调用用户的 Rebalance 监听器
        subscriptions.rebalanceListener().onPartitionsRevoked(revokedPartitions);
    }

    // 4. 清除分配状态
    subscriptions.assign(Collections.emptySet());
}
```

### 4.2 第二阶段：JoinGroup

```java
/**
 * 发送 JoinGroup 请求
 */
private synchronized RequestFuture<ByteBuffer> sendJoinGroupRequest() {
    if (coordinatorUnknown()) {
        return RequestFuture.coordinatorNotAvailable();
    }

    log.debug("(Re-)joining group");

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

    return client.send(coordinator, requestBuilder)
        .compose(new JoinGroupResponseHandler());
}

/**
 * JoinGroup 响应处理
 */
private class JoinGroupResponseHandler
    extends CoordinatorResponseHandler<JoinGroupResponse, ByteBuffer> {

    @Override
    public void handle(JoinGroupResponse response, RequestFuture<ByteBuffer> future) {
        Generation generation = new Generation(
            response.data().generationId(),
            response.data().memberId(),
            response.data().protocolName()
        );

        if (generation.isLeader()) {
            // Leader 执行分区分配
            log.info("Joined group with generation {} and became leader", generation);
            onJoinLeader(generation).chain(future);
        } else {
            // Follower 等待分配结果
            log.info("Joined group with generation {} and became follower", generation);
            onJoinFollower(generation).chain(future);
        }
    }
}
```

### 4.3 第三阶段：SyncGroup

```java
/**
 * Leader 执行分区分配并发送 SyncGroup
 */
private RequestFuture<ByteBuffer> onJoinLeader(Generation generation) {
    try {
        // 执行分区分配
        Map<String, ByteBuffer> groupAssignment = performAssignment(
            generation.protocolName(),
            joinResponse.data().members()
        );

        // 发送 SyncGroup 请求
        return sendSyncGroupRequest(generation, groupAssignment);
    } catch (Exception e) {
        return RequestFuture.failure(e);
    }
}

/**
 * Follower 发送 SyncGroup 请求等待分配结果
 */
private RequestFuture<ByteBuffer> onJoinFollower(Generation generation) {
    // Follower 发送空的 SyncGroup 请求
    return sendSyncGroupRequest(generation, Collections.emptyMap());
}
```

### 4.4 第四阶段：Re-join

```java
/**
 * 完成加入，应用分配结果
 */
private void onJoinComplete(int generation,
                            String memberId,
                            String protocol,
                            ByteBuffer assignmentBuffer) {
    // 反序列化分配结果
    Assignment assignment = ConsumerProtocol.deserializeAssignment(assignmentBuffer);

    log.debug("Received assignment: {}", assignment.partitions());

    // 应用分区分配
    subscriptions.assignFromSubscribed(assignment.partitions());

    // 更新元数据
    metadata.setTopics(subscriptions.groupSubscription());

    // 触发分区分配回调
    if (!assignment.partitions().isEmpty()) {
        subscriptions.rebalanceListener()
            .onPartitionsAssigned(assignment.partitions());
    }

    // 恢复心跳
    heartbeatThread.enable();
}
```

---

## 5. Cooperative Rebalance 流程

### 5.1 增量分配原理

```
Cooperative Rebalance 的核心思想：

传统 Eager Rebalance：
Consumer A: [tp0, tp1, tp2] ─────────────────────▶ [] ──▶ [tp0, tp1, tp4]
Consumer B: [tp3, tp4, tp5] ─────────────────────▶ [] ──▶ [tp2, tp3, tp5]
              ↓
         全部放弃（停止消费）

Cooperative Rebalance：
Consumer A: [tp0, tp1, tp2] ────▶ [tp0, tp1] ────▶ [tp0, tp1, tp4]
Consumer B: [tp3, tp4, tp5] ────▶ [tp3, tp5] ────▶ [tp2, tp3, tp5]
              ↓                       ↓
         只放弃 [tp2]            继续消费
              ↓
         等待新分配
```

### 5.2 第一阶段：Revoke 需要放弃的分区

```java
/**
 * Cooperative Rebalance 第一阶段
 * 只放弃需要重新分配的分区
 */
private void onJoinPrepareForCooperativeRebalance(int generation, String memberId) {
    // 计算需要放弃的分区（而不是全部）
    Set<TopicPartition> partitionsToRevoke =
        calculatePartitionsToRevokeForCooperativeRebalance();

    if (!partitionsToRevoke.isEmpty()) {
        log.info("Giving away partitions: {}", partitionsToRevoke);

        // 只撤销部分分区
        subscriptions.rebalanceListener().onPartitionsRevoked(partitionsToRevoke);

        // 从分配中移除
        subscriptions.assign(subscriptions.assignedPartitions().stream()
            .filter(tp -> !partitionsToRevoke.contains(tp))
            .collect(Collectors.toSet()));
    }
}

/**
 * 计算需要放弃的分区
 */
private Set<TopicPartition> calculatePartitionsToRevokeForCooperativeRebalance() {
    Set<TopicPartition> partitionsToRevoke = new HashSet<>();

    // 策略 1: 如果订阅变化，放弃不再订阅的分区
    for (TopicPartition tp : subscriptions.assignedPartitions()) {
        if (!subscriptions.isSubscribed(tp.topic())) {
            partitionsToRevoke.add(tp);
        }
    }

    // 策略 2: 根据分配策略计算需要移动的分区
    // (在 Leader 返回的分配结果中确定)

    return partitionsToRevoke;
}
```

### 5.3 第二阶段：分配新分区

```java
/**
 * Cooperative Rebalance 第二阶段
 * 获取新分区分配
 */
private RequestFuture<ByteBuffer> onJoinCompleteForCooperativeRebalance(
        int generation,
        String memberId,
        String protocol,
        ByteBuffer assignmentBuffer) {

    Assignment assignment = ConsumerProtocol.deserializeAssignment(assignmentBuffer);

    // 计算新增的分区
    Set<TopicPartition> addedPartitions = new HashSet<>(assignment.partitions());
    addedPartitions.removeAll(subscriptions.assignedPartitions());

    // 计算需要放弃的分区（Leader 决定）
    Set<TopicPartition> revokedPartitions = new HashSet<>(
        subscriptions.assignedPartitions()
    );
    revokedPartitions.removeAll(assignment.partitions());

    // 如果有需要放弃的分区，先放弃
    if (!revokedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsRevoked(revokedPartitions);
    }

    // 更新分配
    subscriptions.assignFromSubscribed(assignment.partitions());

    // 触发新增分区回调
    if (!addedPartitions.isEmpty()) {
        subscriptions.rebalanceListener().onPartitionsAssigned(addedPartitions);
    }

    return RequestFuture.voidSuccess();
}
```

### 5.4 与 Eager 的对比

| 特性 | Eager Rebalance | Cooperative Rebalance |
|-----|-----------------|----------------------|
| 放弃分区 | 全部放弃 | 部分放弃 |
| 消费停顿 | 全组停顿 | 部分停顿 |
| 协议阶段 | 单阶段 | 两阶段 |
| 延迟 | 高 | 低 |
| 兼容性 | 所有版本 | Kafka 2.4+ |

---

## 6. 重平衡性能优化

### 6.1 减少重平衡频率

```java
/**
 * 优化心跳配置
 */
// 增加会话超时时间（默认 10s -> 30s）
props.put("session.timeout.ms", 30000);

// 增加心跳间隔（默认 3s -> 10s）
props.put("heartbeat.interval.ms", 10000);

// 增加最大轮询间隔（默认 5min -> 10min）
props.put("max.poll.interval.ms", 600000);

// 满足公式：session.timeout.ms >= 3 * heartbeat.interval.ms
```

### 6.2 Static Membership 配置

```java
/**
 * 使用静态成员避免重启触发 Rebalance
 */
// 为每个 Consumer 实例配置固定的 ID
props.put("group.instance.id", "consumer-node-1");

// 确保 session.timeout.ms 大于重启时间
// 这样重启后可以在超时前重新加入，保持分区分配
props.put("session.timeout.ms", 60000);  // 1 分钟

// 部署时注意事项：
// 1. 每个实例使用不同的 group.instance.id
// 2. ID 应该与物理/逻辑节点绑定
// 3. 持久化存储，重启后保持一致
```

### 6.3 合理的心跳配置

```java
/**
 * 心跳配置调优
 */
// 高吞吐场景（处理时间长）
props.put("session.timeout.ms", 60000);      // 1 分钟
props.put("heartbeat.interval.ms", 20000);   // 20 秒
props.put("max.poll.interval.ms", 300000);   // 5 分钟

// 低延迟场景（处理时间短）
props.put("session.timeout.ms", 10000);      // 10 秒
props.put("heartbeat.interval.ms", 3000);    // 3 秒
props.put("max.poll.interval.ms", 30000);    // 30 秒

// 配置检查
assert sessionTimeout >= 3 * heartbeatInterval :
    "session.timeout.ms must be >= 3 * heartbeat.interval.ms";
```

### 6.4 max.poll.interval.ms 调优

```java
/**
 * 根据业务处理时间调整
 */
// 场景 1: 快速处理（< 1 秒）
props.put("max.poll.interval.ms", 30000);   // 30 秒
props.put("max.poll.records", 500);          // 每次 500 条

// 场景 2: 中等处理（1-30 秒）
props.put("max.poll.interval.ms", 60000);   // 1 分钟
props.put("max.poll.records", 100);          // 每次 100 条

// 场景 3: 慢速处理（> 30 秒）
props.put("max.poll.interval.ms", 300000);  // 5 分钟
props.put("max.poll.records", 10);           // 每次 10 条

// 场景 4: 批处理（分钟级）
props.put("max.poll.interval.ms", 1800000); // 30 分钟
props.put("max.poll.records", 1);            // 每次 1 条

/**
 * 关键：max.poll.interval.ms 必须大于单批处理时间
 */
```

### 6.5 Rebalance 监听器优化

```java
/**
 * 高效的 Rebalance 监听器实现
 */
public class OptimizedRebalanceListener implements ConsumerRebalanceListener {

    private final KafkaConsumer<String, String> consumer;
    private final Map<TopicPartition, Long> pendingOffsets = new ConcurrentHashMap<>();
    private final AtomicBoolean rebalanceInProgress = new AtomicBoolean(false);

    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        log.info("Partitions revoked: {}", partitions);
        rebalanceInProgress.set(true);

        try {
            // 1. 快速提交未提交的 Offset
            if (!pendingOffsets.isEmpty()) {
                commitPendingOffsets();
            }

            // 2. 取消正在进行的异步操作
            cancelAsyncOperations();

            // 3. 清理线程本地资源
            cleanupThreadLocalResources();

        } catch (Exception e) {
            log.error("Error during partition revocation", e);
        }
    }

    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        log.info("Partitions assigned: {}", partitions);

        try {
            // 1. 恢复消费位置
            seekToLastCommittedPositions(partitions);

            // 2. 初始化分区资源
            initializePartitionResources(partitions);

            // 3. 恢复消费
            rebalanceInProgress.set(false);

        } catch (Exception e) {
            log.error("Error during partition assignment", e);
        }
    }

    private void commitPendingOffsets() {
        try {
            consumer.commitSync(pendingOffsets.entrySet().stream()
                .collect(Collectors.toMap(
                    Map.Entry::getKey,
                    e -> new OffsetAndMetadata(e.getValue())
                )), Duration.ofSeconds(5));
            pendingOffsets.clear();
        } catch (Exception e) {
            log.error("Failed to commit offsets during rebalance", e);
        }
    }
}
```

### 6.6 监控指标

```java
/**
 * Rebalance 监控
 */
// Rebalance 次数
metrics.counter("kafka.consumer.rebalance.total").increment();

// Rebalance 延迟
metrics.timer("kafka.consumer.rebalance.latency").record(duration);

// Rebalance 原因
metrics.counter("kafka.consumer.rebalance.reason",
    "reason", "MEMBER_JOIN"  // 或 MEMBER_LEAVE, SUBSCRIPTION_CHANGE 等
).increment();

// 分区迁移数量
metrics.histogram("kafka.consumer.rebalance.partitions.revoked").record(revokedCount);
metrics.histogram("kafka.consumer.rebalance.partitions.assigned").record(assignedCount);
```

---

**上一章**: [04. 分区分配策略详解](./04-partition-assignor.md)
**下一章**: [06. Offset 管理策略](./06-offset-management.md)
