# 04. 分区分配策略详解

本文档深入分析 Kafka Consumer 的分区分配策略，了解不同分配算法的工作原理和适用场景。

## 目录
- [1. 分区分配概述](#1-分区分配概述)
- [2. RangeAssignor](#2-rangeassignor)
- [3. RoundRobinAssignor](#3-roundrobinassignor)
- [4. StickyAssignor](#4-stickyassignor)
- [5. CooperativeStickyAssignor](#5-cooperativestickyassignor)
- [6. 自定义分配策略](#6-自定义分配策略)

---

## 1. 分区分配概述

### 1.1 分配策略的作用

分区分配策略决定消费组中的消费者如何分配订阅主题的分区：

```
场景：3 个消费者，2 个 Topic（各 6 个分区）

订阅关系：
- Consumer A: [Topic1, Topic2]
- Consumer B: [Topic1, Topic2]
- Consumer C: [Topic1, Topic2]

可用分区：
- Topic1: [0, 1, 2, 3, 4, 5]
- Topic2: [0, 1, 2, 3, 4, 5]

目标：12 个分区分配给 3 个消费者，尽量均衡
```

### 1.2 分配时机

| 场景 | 说明 |
|-----|------|
| **新消费组** | 首次启动时进行初始分配 |
| **成员变化** | Consumer 加入或离开时 |
| **分区变化** | Topic 分区数增加时 |
| **订阅变化** | Consumer 修改订阅列表时 |

### 1.3 ConsumerPartitionAssignor 接口

```java
/**
 * 分区分配策略接口
 */
public interface ConsumerPartitionAssignor {

    /**
     * 执行分区分配
     *
     * @param partitionsPerTopic Topic 到分区数的映射
     * @param subscriptions 消费者 ID 到订阅信息的映射
     * @return 消费者 ID 到分配结果的映射
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
     * 订阅信息（参与分配的消费者信息）
     */
    class Subscription {
        private final List<String> topics;           // 订阅的 Topic 列表
        private final ByteBuffer userData;           // 自定义数据
        private final List<TopicPartition> ownedPartitions; // 当前拥有的分区
    }

    /**
     * 分配结果
     */
    class Assignment {
        private final List<TopicPartition> partitions;  // 分配到的分区
        private final ByteBuffer userData;              // 自定义数据
    }
}
```

---

## 2. RangeAssignor

### 2.1 分配原理

RangeAssignor 按 Topic 范围分配，将每个 Topic 的连续分区分配给消费者：

```
分配公式：
- 每个消费者分配的分区数 = 总分区数 / 消费者数（向上取整）
- 剩余分区分配给前面的消费者

示例：
Topic1 (6 个分区): [0, 1, 2, 3, 4, 5]
消费者: [A, B, C]

计算：
- 每个消费者基础分区数 = 6 / 3 = 2
- Consumer A: 分区 [0, 1]
- Consumer B: 分区 [2, 3]
- Consumer C: 分区 [4, 5]
```

### 2.2 计算步骤

```java
/**
 * RangeAssignor 核心实现
 */
public class RangeAssignor extends AbstractPartitionAssignor {

    @Override
    public String name() {
        return "range";
    }

    @Override
    public Map<String, List<TopicPartition>> assign(
            Map<String, Integer> partitionsPerTopic,
            Map<String, Subscription> subscriptions) {

        Map<String, List<TopicPartition>> assignment = new HashMap<>();
        for (String memberId : subscriptions.keySet()) {
            assignment.put(memberId, new ArrayList<>());
        }

        // 按 Topic 分组消费者
        Map<String, List<String>> consumersPerTopic = consumersPerTopic(subscriptions);

        // 对每个 Topic 分别进行 Range 分配
        for (Map.Entry<String, List<String>> topicEntry : consumersPerTopic.entrySet()) {
            String topic = topicEntry.getKey();
            List<String> consumersForTopic = topicEntry.getValue();

            Integer numPartitionsForTopic = partitionsPerTopic.get(topic);
            if (numPartitionsForTopic == null || numPartitionsForTopic == 0) {
                continue;
            }

            // 按消费者名称排序（保证确定性）
            Collections.sort(consumersForTopic);

            // 计算每个消费者的基础分区数和额外分区数
            int numPartitionsPerConsumer = numPartitionsForTopic / consumersForTopic.size();
            int consumersWithExtraPartition = numPartitionsForTopic % consumersForTopic.size();

            // 分配分区
            int currentPartition = 0;
            for (int i = 0; i < consumersForTopic.size(); i++) {
                String consumer = consumersForTopic.get(i);

                // 前几个消费者多分一个分区
                int numPartitions = numPartitionsPerConsumer +
                    (i < consumersWithExtraPartition ? 1 : 0);

                // 分配连续的分区
                for (int j = 0; j < numPartitions; j++) {
                    assignment.get(consumer).add(new TopicPartition(topic, currentPartition++));
                }
            }
        }

        return assignment;
    }
}
```

### 2.3 优缺点分析

| 优点 | 缺点 |
|-----|------|
| 实现简单 | 分区数不能整除时分配不均 |
| 按 Topic 分配便于管理 | 多 Topic 场景下可能严重不均衡 |
| 分区连续，便于批量处理 | Consumer 增减时重新分配范围大 |

**不均衡示例**：

```
场景：2 个消费者，2 个 Topic

Topic1: 3 个分区 [0, 1, 2]
Topic2: 3 个分区 [0, 1, 2]

分配结果：
- Consumer A: Topic1[0,1], Topic2[0,1] = 4 个分区
- Consumer B: Topic1[2], Topic2[2] = 2 个分区

不均衡！A 是 B 的两倍负载
```

### 2.4 适用场景

- 单个 Topic 消费
- 分区数能被消费者数整除
- 需要连续分区进行批量处理

---

## 3. RoundRobinAssignor

### 3.1 分配原理

RoundRobinAssignor 将所有分区轮询分配给所有消费者：

```
分配方式：
- 将所有分区按顺序排列
- 轮询分配给每个消费者

示例：
Topic1 (4 个分区): [0, 1, 2, 3]
Topic2 (4 个分区): [0, 1, 2, 3]
消费者: [A, B, C]

所有分区排序：
T1-0, T1-1, T1-2, T1-3, T2-0, T2-1, T2-2, T2-3

轮询分配：
- Consumer A: T1-0, T1-3, T2-2
- Consumer B: T1-1, T2-0, T2-3
- Consumer C: T1-2, T2-1

结果：A=3, B=3, C=2（相对均衡）
```

### 3.2 计算步骤

```java
/**
 * RoundRobinAssignor 核心实现
 */
public class RoundRobinAssignor extends AbstractPartitionAssignor {

    @Override
    public String name() {
        return "roundrobin";
    }

    @Override
    public Map<String, List<TopicPartition>> assign(
            Map<String, Integer> partitionsPerTopic,
            Map<String, Subscription> subscriptions) {

        Map<String, List<TopicPartition>> assignment = new HashMap<>();
        for (String memberId : subscriptions.keySet()) {
            assignment.put(memberId, new ArrayList<>());
        }

        // 获取所有订阅的主题
        Set<String> allSubscribedTopics = new HashSet<>();
        for (Subscription subscription : subscriptions.values()) {
            allSubscribedTopics.addAll(subscription.topics());
        }

        // 构建所有分区列表
        List<TopicPartition> allPartitions = new ArrayList<>();
        for (String topic : allSubscribedTopics) {
            Integer numPartitions = partitionsPerTopic.get(topic);
            if (numPartitions != null) {
                for (int i = 0; i < numPartitions; i++) {
                    allPartitions.add(new TopicPartition(topic, i));
                }
            }
        }

        // 对消费者排序（保证确定性）
        List<String> members = new ArrayList<>(subscriptions.keySet());
        Collections.sort(members);

        // 轮询分配
        int memberIndex = 0;
        for (TopicPartition partition : allPartitions) {
            // 只分配给订阅了该 Topic 的消费者
            List<String> consumersForTopic = new ArrayList<>();
            for (String member : members) {
                if (subscriptions.get(member).topics().contains(partition.topic())) {
                    consumersForTopic.add(member);
                }
            }

            if (!consumersForTopic.isEmpty()) {
                // 选择下一个消费者
                String selectedMember = consumersForTopic.get(
                    memberIndex % consumersForTopic.size()
                );
                assignment.get(selectedMember).add(partition);
                memberIndex++;
            }
        }

        return assignment;
    }
}
```

### 3.3 优缺点分析

| 优点 | 缺点 |
|-----|------|
| 多 Topic 场景下更均衡 | 分区分散，不利于批量处理 |
| 实现简单直观 | Consumer 增减时全部分区重分配 |
| 适用于异构订阅 | 无法保持分配的连续性 |

### 3.4 适用场景

- 多个 Topic 消费
- 订阅列表不完全相同
- 对分配均衡性要求高

---

## 4. StickyAssignor

### 4.1 分配原理

StickyAssignor 在均衡的基础上，尽量保持现有分配不变：

```
分配目标（按优先级排序）：
1. 均衡：每个消费者分配到的分区数量尽量相同
2. 粘性：尽量保持上一次的分配结果
3. 最小化迁移：Consumer 增减时，最小化受影响的分区

示例：
初始分配（3 个 Consumer，6 个分区）：
- A: [0, 1]
- B: [2, 3]
- C: [4, 5]

Consumer C 离开后：
- A: [0, 1, 4]  (新增 4)
- B: [2, 3, 5]  (新增 5)

而不是：
- A: [0, 2, 4]  (改变了 2 个分区)
- B: [1, 3, 5]  (改变了 2 个分区)
```

### 4.2 粘性策略目标

```java
/**
 * StickyAssignor 核心逻辑
 */
public class StickyAssignor extends AbstractPartitionAssignor {

    @Override
    public String name() {
        return "sticky";
    }

    @Override
    public Map<String, List<TopicPartition>> assign(
            Map<String, Integer> partitionsPerTopic,
            Map<String, Subscription> subscriptions) {

        // 解析当前分配（从 userData 获取）
        Map<String, List<TopicPartition>> currentAssignment = new HashMap<>();
        for (Map.Entry<String, Subscription> entry : subscriptions.entrySet()) {
            ByteBuffer userData = entry.getValue().userData();
            if (userData != null) {
                currentAssignment.put(entry.getKey(),
                    deserializeTopicPartitionList(userData));
            } else {
                currentAssignment.put(entry.getKey(), new ArrayList<>());
            }
        }

        // 步骤 1: 尽量保持现有分配
        // 步骤 2: 从离开的消费者那里回收分区
        // 步骤 3: 重新分配回收的分区，保持均衡
        // 步骤 4: 如果仍然不均衡，在现有消费者之间移动分区

        return balancedAssignment;
    }

    /**
     * 检查分配是否均衡
     */
    private boolean isBalanced(Map<String, List<TopicPartition>> assignment,
                               int numPartitions) {
        int numConsumers = assignment.size();
        int minPartitions = numPartitions / numConsumers;
        int maxPartitions = (numPartitions + numConsumers - 1) / numConsumers;

        for (List<TopicPartition> partitions : assignment.values()) {
            if (partitions.size() < minPartitions || partitions.size() > maxPartitions) {
                return false;
            }
        }
        return true;
    }
}
```

### 4.3 与 Range/RoundRobin 的对比

```
场景对比：Consumer C 离开后重新分配

RangeAssignor:
- 全部分区重新计算范围
- 所有 Consumer 的分区都可能改变
- 影响：A 和 B 的分区都变化

RoundRobinAssignor:
- 全部分区重新轮询
- 所有 Consumer 的分区都可能改变
- 影响：A 和 B 的分区都变化

StickyAssignor:
- 优先保持现有分配
- 只移动必要的分区
- 影响：A 和 B 各自新增 1 个分区，原有分区不变
```

### 4.4 优缺点分析

| 优点 | 缺点 |
|-----|------|
| 减少重平衡时的分区迁移 | 分配算法较复杂 |
| 保持缓存和连接复用 | 极端情况下可能略不均衡 |
| 提高消费连续性 | 需要序列化/反序列化 userData |

---

## 5. CooperativeStickyAssignor

### 5.1 增量重平衡 (Incremental Rebalance)

CooperativeStickyAssignor 在 StickyAssignor 基础上增加了增量重平衡能力：

```
传统 Rebalance（Eager）vs 增量 Rebalance（Cooperative）：

Eager Rebalance：
1. 所有 Consumer 放弃全部分区
2. 停止消费
3. 等待重新分配
4. 获得新分区
5. 恢复消费

Cooperative Rebalance：
1. 第一阶段：只放弃需要重新分配的分区
2. 大部分分区继续消费
3. 第二阶段：分配新分区
4. 最小化消费停顿
```

### 5.2 与 StickyAssignor 的区别

```java
/**
 * CooperativeStickyAssignor
 */
public class CooperativeStickyAssignor extends StickyAssignor {

    @Override
    public String name() {
        return "cooperative-sticky";
    }

    @Override
    public List<RebalanceProtocol> supportedProtocols() {
        // 支持 EAGER 和 COOPERATIVE 两种协议
        return Arrays.asList(
            RebalanceProtocol.COOPERATIVE,
            RebalanceProtocol.EAGER
        );
    }

    /**
     * 第一阶段的分配（只撤销需要重新分配的分区）
     */
    @Override
    public Map<String, Assignment> assign(
            Cluster metadata,
            GroupSubscription groupSubscription) {

        // 检查是否需要两阶段重平衡
        if (needsTwoPhaseRebalance(groupSubscription)) {
            // 第一阶段：返回空的分配，触发撤销部分分区
            return firstPhaseAssignment(groupSubscription);
        } else {
            // 直接进行完整分配
            return completeAssignment(metadata, groupSubscription);
        }
    }
}
```

### 5.3 重平衡流程优化

```
两阶段重平衡流程：

第一阶段（Revoke）：
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ Consumer A  │   │ Consumer B  │   │ Consumer C  │
│ [0, 1, 2]   │   │ [3, 4, 5]   │   │ 新加入      │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                  │                  │
       │   JoinGroup      │   JoinGroup      │   JoinGroup
       └──────────────────┼──────────────────┘
                          ▼
                   ┌─────────────┐
                   │ Coordinator │
                   └──────┬──────┘
                          │
       ┌──────────────────┼──────────────────┐
       │   SyncGroup      │   SyncGroup      │   SyncGroup
       │   [0, 1]         │   [4, 5]         │   []
       ▼                  ▼                  ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ 放弃 [2]    │   │ 放弃 [3]    │   │ 等待分配    │
│ 继续消费    │   │ 继续消费    │   │             │
│ [0, 1]      │   │ [4, 5]      │   │             │
└─────────────┘   └─────────────┘   └─────────────┘

第二阶段（Assign）：
       │                  │                  │
       │   JoinGroup      │   JoinGroup      │   JoinGroup
       └──────────────────┼──────────────────┘
                          ▼
                   ┌─────────────┐
                   │ Coordinator │
                   └──────┬──────┘
                          │
       ┌──────────────────┼──────────────────┐
       │   SyncGroup      │   SyncGroup      │   SyncGroup
       │   [0, 1, 2]      │   [4, 5]         │   [3]
       ▼                  ▼                  ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ [0, 1, 2]   │   │ [4, 5]      │   │ [3]         │
└─────────────┘   └─────────────┘   └─────────────┘

优势：
- A 只在第二阶段短暂停止消费 [2]
- B 全程不需要停止消费
- 总体停顿时间大幅减少
```

### 5.4 Kafka 2.4+ 推荐策略

```java
// 配置使用 CooperativeStickyAssignor（Kafka 2.4+ 默认）
props.put("partition.assignment.strategy",
    "org.apache.kafka.clients.consumer.CooperativeStickyAssignor");

// 所有 Consumer 必须使用相同的策略
// 混合使用不同策略会导致 UnsupportedVersionException
```

**推荐场景**：

| 场景 | 推荐策略 |
|-----|---------|
| Kafka 2.4+ | CooperativeStickyAssignor |
| 频繁 Rebalance | CooperativeStickyAssignor |
| 需要连续性 | StickyAssignor |
| 简单场景 | RangeAssignor / RoundRobinAssignor |

---

## 6. 自定义分配策略

### 6.1 实现步骤

```java
/**
 * 自定义分区分配策略示例
 * 基于消费者权重的分配策略
 */
public class WeightedAssignor implements ConsumerPartitionAssignor {

    @Override
    public String name() {
        return "weighted";
    }

    @Override
    public Map<String, Assignment> assign(
            Cluster metadata,
            GroupSubscription groupSubscription) {

        // 1. 收集所有订阅信息
        Map<String, Subscription> subscriptions = groupSubscription.groupSubscription();

        // 2. 解析每个消费者的权重（从 userData）
        Map<String, Integer> consumerWeights = new HashMap<>();
        for (Map.Entry<String, Subscription> entry : subscriptions.entrySet()) {
            int weight = parseWeight(entry.getValue().userData());
            consumerWeights.put(entry.getKey(), weight);
        }

        // 3. 计算总权重
        int totalWeight = consumerWeights.values().stream().mapToInt(Integer::intValue).sum();

        // 4. 收集所有分区
        List<TopicPartition> allPartitions = new ArrayList<>();
        for (String topic : allSubscribedTopics(subscriptions)) {
            List<PartitionInfo> partitions = metadata.partitionsForTopic(topic);
            for (PartitionInfo partition : partitions) {
                allPartitions.add(new TopicPartition(topic, partition.partition()));
            }
        }

        // 5. 按权重比例分配
        Map<String, Assignment> assignment = new HashMap<>();
        int totalPartitions = allPartitions.size();

        int currentPartition = 0;
        for (Map.Entry<String, Integer> entry : consumerWeights.entrySet()) {
            String consumer = entry.getKey();
            int weight = entry.getValue();

            // 计算该消费者应得的分区数
            int numPartitions = (int) Math.round(
                (double) totalPartitions * weight / totalWeight
            );

            List<TopicPartition> consumerPartitions = new ArrayList<>();
            for (int i = 0; i < numPartitions && currentPartition < totalPartitions; i++) {
                consumerPartitions.add(allPartitions.get(currentPartition++));
            }

            assignment.put(consumer, new Assignment(consumerPartitions));
        }

        return assignment;
    }

    private int parseWeight(ByteBuffer userData) {
        if (userData == null) return 1; // 默认权重
        return userData.getInt();
    }
}
```

### 6.2 自定义逻辑示例

**基于机架感知的分配策略**：

```java
/**
 * 机架感知分配策略
 * 优先将副本与消费者部署在同一机架，减少跨机架流量
 */
public class RackAwareAssignor implements ConsumerPartitionAssignor {

    @Override
    public String name() {
        return "rack-aware";
    }

    @Override
    public Map<String, Assignment> assign(
            Cluster metadata,
            GroupSubscription groupSubscription) {

        // 获取每个消费者的机架信息
        Map<String, String> consumerRacks = new HashMap<>();
        for (Map.Entry<String, Subscription> entry :
             groupSubscription.groupSubscription().entrySet()) {
            String rack = extractRack(entry.getValue().userData());
            consumerRacks.put(entry.getKey(), rack);
        }

        // 分配时优先选择 Leader 在同一机架的分区
        Map<String, Assignment> assignment = new HashMap<>();

        for (Map.Entry<String, String> entry : consumerRacks.entrySet()) {
            String consumer = entry.getKey();
            String rack = entry.getValue();

            List<TopicPartition> preferredPartitions = new ArrayList<>();

            for (TopicPartition tp : allPartitions) {
                Node leader = metadata.leaderFor(tp);
                if (leader != null && rack.equals(leader.rack())) {
                    preferredPartitions.add(tp);
                }
            }

            assignment.put(consumer, new Assignment(preferredPartitions));
        }

        return assignment;
    }
}
```

### 6.3 配置使用

```java
// 配置自定义分配策略
props.put("partition.assignment.strategy",
    "com.example.WeightedAssignor");

// 多个策略（按优先级排序）
props.put("partition.assignment.strategy",
    "com.example.CustomAssignor,org.apache.kafka.clients.consumer.RangeAssignor");

// 消费者指定权重（在订阅时传入 userData）
ByteBuffer weightData = ByteBuffer.allocate(4).putInt(2).flip();
subscription = new Subscription(
    topics,
    weightData  // 自定义数据，Assignor 可以读取
);
```

### 6.4 注意事项

| 注意事项 | 说明 |
|---------|------|
| **一致性** | 同一消费组的所有 Consumer 必须使用相同的分配策略 |
| **确定性** | 分配结果必须是确定的（相同输入产生相同输出） |
| **均衡性** | 尽量保证分区数量均衡分配 |
| **性能** | 分配算法不要太复杂，避免影响重平衡时间 |
| **兼容性** | 考虑与不同 Kafka 版本的兼容性 |

---

**上一章**: [03. ConsumerCoordinator 消费组协调器](./03-consumer-coordinator.md)
**下一章**: [05. Consumer Rebalance 重平衡详解](./05-rebalance-process.md)
