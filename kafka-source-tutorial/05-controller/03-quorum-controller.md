# 03. QuorumController 核心实现

> **本文档导读**
>
> 本文档深入分析 QuorumController 的核心实现，包括单线程事件处理模型和请求处理机制。
>
> **预计阅读时间**: 45 分钟
>
> **相关文档**:
> - [02-startup-flow.md](./02-startup-flow.md) - ControllerServer 启动流程
> - [04-raft-implementation.md](./04-raft-implementation.md) - Raft 协议实现

---

## 3. QuorumController 核心实现

### 3.1 单线程事件模型

```java
/**
 * QuorumController 设计哲学:
 *
 * 1. 单线程事件处理
 *    - 所有操作都在同一个事件队列中执行
 *    - 避免复杂的锁机制
 *    - 保证操作的顺序性
 *
 * 2. 异步 API
 *    - 所有公开 API 都返回 CompletableFuture
 *    - 调用者不会阻塞
 *    - 结果在事件完成后通过 Future 返回
 *
 * 3. Raft 集成
 *    - 元数据变更通过 Raft 协议复制
 *    - 只有 Leader 可以写入元数据
 *    - Follower 只能读取
 */

// org/apache/kafka/controller/QuorumController.java

public final class QuorumController implements Controller {
    /**
     * 事件队列: 所有操作都在这个队列中串行执行
     */
    private final KafkaEventQueue eventQueue;

    /**
     * Raft 客户端: 用于读写元数据日志
     */
    private final RaftClient<ApiMessageAndVersion> raftClient;

    /**
     * 元数据快照: 当前集群元数据的完整视图
     */
    private final MetadataDelta metadataDelta;

    /**
     * 集群控制管理器: 管理 Broker 注册、心跳等
     */
    private final ClusterControlManager clusterControl;

    /**
     * 分区管理器：管理 Topic、Partition、副本分配
     */
    private final PartitionReplicationReplicaManager partitionManager;

    /**
     * 配置管理器: 管理动态配置
     */
    private final ConfigurationControlManager configurationControl;

    /**
     * 特性管理器: 管理特性版本
     */
    private final FeatureControlManager featureControl;

    // ... 其他管理器
}
```

### 3.2 QuorumController 初始化

```java
// QuorumController.Builder.build()

public QuorumController build() {
    // ========== 1. 创建快照注册表 ==========
    /**
     * SnapshotRegistry 用于管理元数据快照
     * 支持时间旅行查询和回滚
     */
    SnapshotRegistry snapshotRegistry = new SnapshotRegistry(logContext);

    // ========== 2. 创建事件队列 ==========
    /**
     * KafkaEventQueue 是一个单线程事件队列
     * 所有操作都在这个队列中执行
     */
    KafkaEventQueue eventQueue = new KafkaEventQueue(
        Time.SYSTEM,
        logContext,
        new EarliestDeadlineFunction(),
        "quorum-controller-" + nodeId + "-",
        true  // 单线程模式
    );

    // ========== 3. 创建各个管理器 ==========
    ClusterControlManager clusterControl = new ClusterControlManager.Builder()
        .setNodeId(nodeId)
        .setTime(time)
        .setThreadNamePrefix(threadNamePrefix)
        .setSnapshotRegistry(snapshotRegistry)
        .setLogContext(logContext)
        .setSessionTimeoutNs(sessionTimeoutNs)
        .setBrokerHeartbeatIntervalNs(brokerHeartbeatIntervalNs)
        .setFatalFaultHandler(fatalFaultHandler)
        .build();

    PartitionReplicationReplicaManager partitionManager =
        new PartitionReplicationReplicaManager.Builder()
            .setNodeId(nodeId)
            .setTime(time)
            .setThreadNamePrefix(threadNamePrefix)
            .setSnapshotRegistry(snapshotRegistry)
            .setLogContext(logContext)
            .setDefaultReplicationFactor(defaultReplicationFactor)
            .setDefaultNumPartitions(defaultNumPartitions)
            .setReplicaPlacer(replicaPlacer)
            .setLeaderImbalanceCheckIntervalNs(leaderImbalanceCheckIntervalNs)
            .build();

    ConfigurationControlManager configurationControl =
        new ConfigurationControlManager.Builder()
            .setNodeId(nodeId)
            .setTime(time)
            .setSnapshotRegistry(snapshotRegistry)
            .setLogContext(logContext)
            .setConfigSchema(configSchema)
            .build();

    FeatureControlManager featureControl = new FeatureControlManager.Builder()
        .setNodeId(nodeId)
        .setTime(time)
        .setThreadNamePrefix(threadNamePrefix)
        .setSnapshotRegistry(snapshotRegistry)
        .setLogContext(logContext)
        .setQuorumFeatures(quorumFeatures)
        .build();

    // ... 其他管理器

    // ========== 4. 创建 QuorumController ==========
    QuorumController controller = new QuorumController(
        logContext,
        nodeId,
        clusterId,
        time,
        threadNamePrefix,
        snapshotRegistry,
        eventQueue,
        raftClient,
        maxRecordsPerBatch,
        // ... 各个管理器
    );

    // ========== 5. 初始化 Raft 客户端 ==========
    /**
     * 设置 Raft 回调:
     * - 当成为 Leader 时调用
     * - 当有新记录可以读取时调用
     * - 当快照需要创建时调用
     */
    raftClient.register(listener);

    return controller;
}
```

### 3.3 CreateTopic 请求处理流程

```java
/**
 * CreateTopic 完整流程:
 *
 * 1. ControllerApis 接收请求
 * 2. 转发到 QuorumController
 * 3. 在事件队列中处理
 * 4. 生成元数据记录
 * 5. 通过 Raft 写入日志
 * 6. 等待多数节点确认
 * 7. 更新内存中的元数据
 * 8. 通知所有 Publishers
 * 9. 返回结果给客户端
 */

// QuorumController.createTopics()

public CompletableFuture<CreateTopicsResponseData> createTopics(
    CreateTopicsRequestData request
) {
    // ========== 1. 创建异步操作 ==========
    /**
     * ControllerOperation 是一个封装了操作逻辑的对象
     * 它会在事件队列中执行
     */
    CreateTopicsOperation op = new CreateTopicsOperation(
        request,
        deadline,
        apiTimeoutTimeNs
    );

    /**
     * 将操作放入事件队列
     * 不会阻塞当前线程
     */
    appendEvent(op);
    return op.future();
}

// ========== 2. 操作在事件队列中执行 ==========

private class CreateTopicsOperation extends ControllerOperation {
    @Override
    public void run() throws Exception {
        // ========== 2.1 检查是否是 Leader ==========
        /**
         * 只有 Leader 可以处理写请求
         * Follower 会将请求转发给 Leader
         */
        if (!isActiveController()) {
            completeFuture(new ApiError(
                NOT_CONTROLLER,
                "This controller is not the active controller."
            ));
            return;
        }

        // ========== 2.2 验证请求 ==========
        /**
         * 检查:
         * - Topic 名称是否合法
         * - Topic 是否已存在
         * - 副本因子是否合理
         * - 分区数是否合理
         */
        ApiError error = validateCreateTopics(request);
        if (error.isFailure()) {
            completeFuture(error);
            return;
        }

        // ========== 2.3 生成元数据记录 ==========
        /**
         * 为每个 Topic 生成元数据记录:
         * - TopicRecord: Topic 元数据
         * - PartitionRecord: 分区元数据
         */
        List<ApiMessageAndVersion> records = new ArrayList<>();

        for (CreatableTopic topic : request.topics()) {
            // 生成 TopicRecord
            records.add(new ApiMessageAndVersion(
                new TopicRecord()
                    .setName(topic.name())
                    .setTopicId(topicId),
                topic.topicId() == null ? (short) 0 : (short) 1
            ));

            // 为每个分区生成 PartitionRecord
            for (CreatablePartition partition : topic.assignments()) {
                // 计算副本分配
                List<Integer> replicas = partitionManager.assignReplicas(
                    partition.brokerIds(),
                    partition.replicationFactor()
                );

                records.add(new ApiMessageAndVersion(
                    new PartitionRecord()
                        .setTopicId(topicId)
                        .setPartitionId(partition.partitionIndex())
                        .setReplicas(replicas)
                        .setIsr(replicas)
                        .setLeader(replicas.get(0)),
                    (short) 0
                ));
            }
        }

        // ========== 2.4 写入元数据日志 ==========
        /**
         * 通过 Raft 协议写入记录
         * 这个操作会:
         * 1. 写入本地日志
         * 2. 复制到 Follower
         * 3. 等待多数节点确认
         * 4. 返回写入结果
         */
        CompletableFuture<Long> appendFuture = raftClient.append(
            records,
            AppendRequest.DEFAULT_TIMEOUT_MS,
            false  // 是否需要全部确认
        );

        // ========== 2.5 等待写入完成 ==========
        appendFuture.whenComplete((offset, exception) -> {
            if (exception != null) {
                completeFuture(new ApiError(
                    UNKNOWN_SERVER_ERROR,
                    "Failed to append to metadata log: " + exception.getMessage()
                ));
            } else {
                // ========== 2.6 创建响应 ==========
                completeFuture(null);  // 成功
            }
        });
    }
}
```

### 3.4 元数据记录类型

```java
/**
 * Kafka 的元数据通过多种类型的记录表示
 * 每种记录对应一种元数据变更
 */

// ===== 核心元数据记录 =====

// 1. TopicRecord: Topic 元数据
class TopicRecord {
    String name;        // Topic 名称
    Uuid topicId;       // Topic 唯一 ID
}

// 2. PartitionRecord: 分区元数据
class PartitionRecord {
    Uuid topicId;           // 所属 Topic ID
    int partitionId;        // 分区 ID
    List<Integer> replicas; // 副本列表
    List<Integer> isr;      // In-Sync Replicas
    int leader;             // Leader 副本
    int leaderEpoch;        // Leader 版本号
    int partitionEpoch;     // 分区版本号
}

// 3. RegisterBrokerRecord: Broker 注册
class RegisterBrokerRecord {
    int brokerId;           // Broker ID
    Uuid brokerUuid;        // Broker 唯一 ID
    String rack;            // 机架信息
    long epoch;             // Broker 版本号
    boolean fenced;         // 是否被隔离
}

// 4. BrokerRegistrationChangeRecord: Broker 变更
class BrokerRegistrationChangeRecord {
    int brokerId;
    long brokerEpoch;
    boolean fenced;
}

// 5. ConfigRecord: 配置变更
class ConfigRecord {
    String resourceType;    // 资源类型 (Topic/Broker)
    String resourceName;    // 资源名称
    String configKey;       // 配置键
    String configValue;     // 配置值
}

// 6. AccessControlEntryRecord: ACL
class AccessControlEntryRecord {
    String resourceType;
    String resourceName;
    String principal;
    String host;
    String operation;
    String permissionType;
}

// 7. FeatureLevelRecord: 特性版本
class FeatureLevelRecord {
    String name;        // 特性名称
    long featureLevel;  // 特性版本号
}

// ... 还有 20+ 种其他记录类型
```

---
