# 05. 分区器详解

本文档深入分析 Kafka Producer 的分区器实现，了解消息如何被分配到不同分区。

## 目录
- [1. Partitioner 接口](#1-partitioner-接口)
- [2. 默认分区策略](#2-默认分区策略)
- [3. 内置分区器](#3-内置分区器)
- [4. 自定义分区器](#4-自定义分区器)
- [5. 粘性分区策略](#5-粘性分区策略)

---

## 1. Partitioner 接口

### 1.1 接口定义

```java
/**
 * Partitioner 接口 - 确定消息发送到哪个分区
 */
public interface Partitioner extends Configurable, Closeable {

    /**
     * 计算消息应该发送到哪个分区
     *
     * @param topic 目标 Topic 名称
     * @param key 消息的 key（可能为 null）
     * @param keyBytes key 的序列化字节数组（可能为 null）
     * @param value 消息的 value
     * @param valueBytes value 的序列化字节数组
     * @param cluster 集群元数据信息
     * @return 目标分区号（0 到 partitionCount-1）
     */
    int partition(String topic,
                  Object key,
                  byte[] keyBytes,
                  Object value,
                  byte[] valueBytes,
                  Cluster cluster);

    /**
     * 关闭分区器，释放资源
     */
    default void close() {}

    /**
     * 配置分区器
     */
    default void configure(Map<String, String> configs) {}
}
```

### 1.2 partition() 方法参数

| 参数 | 类型 | 说明 |
|-----|------|------|
| `topic` | String | 目标 Topic 名称 |
| `key` | Object | 消息的业务 Key（可为 null） |
| `keyBytes` | byte[] | key 序列化后的字节数组（可为 null） |
| `value` | Object | 消息的业务 Value |
| `valueBytes` | byte[] | value 序列化后的字节数组 |
| `cluster` | Cluster | 集群元数据，包含分区信息 |

### 1.3 关闭方法

```java
// 分区器生命周期
KafkaProducer producer = new KafkaProducer<>(props);
// 1. 配置分区器
partitioner.configure(configs);

// 2. 多次调用 partition() 发送消息
for (int i = 0; i < 10000; i++) {
    int partition = partitioner.partition(...);
    // 发送消息...
}

// 3. 关闭时释放资源
producer.close();  // 内部调用 partitioner.close()
```

---

## 2. 默认分区策略

### 2.1 分区策略决策树

```
                            开始分区计算
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
            ▼                    ▼                    ▼
      partition 已指定      partition 未指定        partition 未指定
            │                    │                    │
            │               key != null            key == null
            │                    │                    │
            ▼                    ▼                    ▼
      使用指定分区        按 key hash 分区        粘性分区
            │                    │                    │
            ▼                    ▼                    ▼
      return partition   Utils.murmur2(key)    BuiltInPartitioner
                         % numPartitions       .partition()
```

### 2.2 有 key 的情况

```java
// 使用 murmur2 哈希算法计算 key 的 hash
int partition = Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
```

**murmur2 哈希算法特点**：

| 特点 | 说明 |
|-----|------|
| **高性能** | 非加密哈希，计算速度快 |
| **低碰撞率** | 哈希分布均匀 |
| **一致性** | 相同 key 总是映射到同一分区 |

```java
// Utils.murmur2 实现
public static int murmur2(final byte[] data) {
    int length = data.length;
    int seed = 0x9747b28c;  // 随机种子
    final int m = 0x5bd1e995;
    final int r = 24;

    int h = seed ^ length;
    int length4 = length / 4;

    for (int i = 0; i < length4; i++) {
        final int i4 = i * 4;
        int k = (data[i4 + 0] & 0xff) + ((data[i4 + 1] & 0xff) << 8)
              + ((data[i4 + 2] & 0xff) << 16) + ((data[i4 + 3] & 0xff) << 24);
        k *= m;
        k ^= k >>> r;
        k *= m;
        h *= m;
        h ^= k;
    }

    // 处理剩余字节...

    h ^= h >>> 13;
    h *= m;
    h ^= h >>> 15;

    return h;
}

// 确保结果为正数
public static int toPositive(int number) {
    return number & 0x7fffffff;
}
```

**key 分区策略的优势**：

```java
// 相同 userId 的消息总是发送到同一分区
// 保证同一用户的消费顺序
producer.send(new ProducerRecord<>("user-events", userId, event));

// 例如：
// userId="user123" -> hash=12345 -> partition=0
// userId="user456" -> hash=67890 -> partition=2
// userId="user123" -> hash=12345 -> partition=0 (始终相同)
```

### 2.3 无 key 的情况

```java
// Kafka 2.4+ 使用粘性分区策略
// Kafka 2.4 之前使用轮询策略

// BuiltInPartitioner 粘性分区实现
public int partition(String topic, int numPartitions) {
    // 使用当前的粘性分区
    int part = stickyPartition;

    // 如果当前批次已满，切换粘性分区
    if (batchIsFull(topic, part)) {
        stickyPartition = nextPartition(topic, numPartitions);
    }

    return part;
}
```

---

## 3. 内置分区器

### 3.1 DefaultPartitioner（已弃用）

```java
/**
 * @deprecated 从 Kafka 2.4.0 开始被 BuiltInPartitioner 取代
 *             配置 "partitioner.class" 不再生效
 */
@Deprecated
public class DefaultPartitioner implements Partitioner {
    private final ConcurrentMap<String, AtomicInteger> topicCounterMap;

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();

        if (keyBytes == null) {
            // 无 key：轮询分区
            int nextValue = nextValue(topic);
            List<PartitionInfo> availablePartitions =
                cluster.availablePartitionsForTopic(topic);
            if (availablePartitions.size() > 0) {
                int part = Utils.toPositive(nextValue) % availablePartitions.size();
                return availablePartitions.get(part).partition();
            }
            return Utils.toPositive(nextValue) % numPartitions;
        }

        // 有 key：hash 分区
        return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
    }

    private int nextValue(String topic) {
        AtomicInteger counter = topicCounterMap.computeIfAbsent(
            topic, k -> new AtomicInteger(0));
        return counter.getAndIncrement();
    }
}
```

### 3.2 RoundRobinPartitioner

```java
/**
 * 轮询分区器 - 将消息均匀分布到所有分区
 */
public class RoundRobinPartitioner implements Partitioner {

    private final ConcurrentMap<String, AtomicInteger> topicCounterMap;

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();

        // 获取下一个分区号
        int nextValue = nextValue(topic);

        // 只在可用分区中轮询
        List<PartitionInfo> availablePartitions =
            cluster.availablePartitionsForTopic(topic);

        if (!availablePartitions.isEmpty()) {
            int part = Utils.toPositive(nextValue) % availablePartitions.size();
            return availablePartitions.get(part).partition();
        }

        // 无可用分区，在所有分区中轮询
        return Utils.toPositive(nextValue) % numPartitions;
    }

    private int nextValue(String topic) {
        AtomicInteger counter = topicCounterMap.get(topic);
        if (counter == null) {
            counter = new AtomicInteger(ThreadLocalRandom.current().nextInt());
            AtomicInteger currentCounter = topicCounterMap.putIfAbsent(topic, counter);
            if (currentCounter != null) {
                counter = currentCounter;
            }
        }
        return counter.getAndIncrement();
    }
}
```

**适用场景**：

| 场景 | 建议 |
|-----|------|
| 消息无顺序要求 | 使用 RoundRobinPartitioner 实现均匀分布 |
| 分区负载均衡 | 消息均匀分布到所有分区 |
| 批量消费优化 | 每个消费者均匀分配分区 |

### 3.3 BuiltInPartitioner（Kafka 2.4+）

```java
/**
 * Kafka 2.4.0+ 的默认分区器
 * 使用粘性分区策略优化批处理性能
 */
public class BuiltInPartitioner {

    // 每个 Topic 的分区状态
    private final ConcurrentMap<String, TopicInfo> topicInfoMap;

    // 粘性分区选择器
    private final PartitionLoadStats loadStats;

    /**
     * 分区计算
     */
    public int partition(String topic, int numPartitions) {
        TopicInfo topicInfo = topicInfoMap.computeIfAbsent(
            topic, t -> new TopicInfo(t, numPartitions));

        // 获取当前粘性分区
        int partition = topicInfo.getStickyPartition();

        // 检查是否需要切换分区
        if (topicInfo.shouldSwitchPartition()) {
            partition = topicInfo.switchPartition();
        }

        return partition;
    }

    /**
     * Topic 分区状态
     */
    private class TopicInfo {
        private final String topic;
        private volatile int stickyPartition;
        private volatile long partitionSwitchTime;
        private final AtomicInteger batchAccumulator;

        TopicInfo(String topic, int numPartitions) {
            this.topic = topic;
            // 随机选择初始粘性分区
            this.stickyPartition = ThreadLocalRandom.current().nextInt(numPartitions);
            this.partitionSwitchTime = time.milliseconds();
            this.batchAccumulator = new AtomicInteger(0);
        }

        /**
         * 检查是否应该切换分区
         */
        boolean shouldSwitchPartition() {
            // 1. 检查批次计数
            if (batchAccumulator.get() >= BATCH_SIZE_TARGET) {
                return true;
            }

            // 2. 检查时间窗口
            long elapsed = time.milliseconds() - partitionSwitchTime;
            if (elapsed > MAX_PARTITION_STICKY_TIME_MS) {
                return true;
            }

            return false;
        }

        /**
         * 切换到下一个分区
         */
        int switchPartition() {
            int numPartitions = cluster.partitionCountForTopic(topic);
            stickyPartition = (stickyPartition + 1) % numPartitions;
            partitionSwitchTime = time.milliseconds();
            batchAccumulator.set(0);
            return stickyPartition;
        }
    }
}
```

---

## 4. 自定义分区器

### 4.1 实现步骤

```java
/**
 * 自定义分区器 - 基于业务特征的分区策略
 */
public class BusinessPartitioner implements Partitioner {

    // 分区权重配置
    private Map<String, Integer> partitionWeights;

    @Override
    public void configure(Map<String, ?> configs) {
        // 读取配置
        String weights = (String) configs.get("partition.weights");
        parseWeights(weights);
    }

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {

        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();

        // 优先级消息分配到前几个分区
        if (isHighPriority(value)) {
            return ThreadLocalRandom.current().nextInt(numPartitions / 2);
        }

        // 普通消息分配到后几个分区
        return numPartitions / 2 +
               ThreadLocalRandom.current().nextInt(numPartitions - numPartitions / 2);
    }

    private boolean isHighPriority(Object value) {
        // 根据业务逻辑判断优先级
        if (value instanceof OrderEvent) {
            return ((OrderEvent) value).isUrgent();
        }
        return false;
    }

    @Override
    public void close() {
        // 清理资源
        partitionWeights.clear();
    }
}
```

### 4.2 业务场景案例

**场景 1: VIP 用户优先分区**

```java
/**
 * VIP 用户的消息优先处理
 */
public class VipPartitioner implements Partitioner {

    private Set<String> vipUsers;

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {

        int numPartitions = cluster.partitionCountForTopic(topic);
        String userId = (String) key;

        // VIP 用户使用 0 号分区（独立消费者组优先处理）
        if (vipUsers.contains(userId)) {
            return 0;
        }

        // 普通用户均匀分布到其他分区
        return 1 + Utils.toPositive(Utils.murmur2(keyBytes)) % (numPartitions - 1);
    }
}

// 配置使用
props.put("partitioner.class", "com.example.VipPartitioner");
```

**场景 2: 地域分区**

```java
/**
 * 按地域分配分区
 */
public class RegionPartitioner implements Partitioner {

    private final Map<String, Integer> regionPartitionMap = new HashMap<>();

    public RegionPartitioner() {
        regionPartitionMap.put("beijing", 0);
        regionPartitionMap.put("shanghai", 1);
        regionPartitionMap.put("guangzhou", 2);
        regionPartitionMap.put("shenzhen", 3);
    }

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {

        String region = extractRegion(value);
        Integer partition = regionPartitionMap.get(region);

        if (partition != null) {
            return partition;
        }

        // 未知地域，使用默认分区
        int numPartitions = cluster.partitionCountForTopic(topic);
        return ThreadLocalRandom.current().nextInt(numPartitions);
    }

    private String extractRegion(Object value) {
        if (value instanceof Order) {
            return ((Order) value).getRegion();
        }
        return "unknown";
    }
}
```

**场景 3: 时间窗口分区**

```java
/**
 * 按时间窗口分配分区
 * 适用于需要按时间聚合数据的场景
 */
public class TimeWindowPartitioner implements Partitioner {

    private final long windowSizeMs;

    public TimeWindowPartitioner() {
        this.windowSizeMs = 60000;  // 1 分钟窗口
    }

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {

        int numPartitions = cluster.partitionCountForTopic(topic);

        // 基于当前时间计算窗口
        long currentWindow = System.currentTimeMillis() / windowSizeMs;

        // 同一窗口的消息进入同一分区
        return (int) (currentWindow % numPartitions);
    }
}
```

### 4.3 注意事项

```java
/**
 * 自定义分区器最佳实践
 */
public class BestPracticePartitioner implements Partitioner {

    // 1. 使用线程安全的数据结构
    private final ConcurrentHashMap<String, AtomicInteger> counters;

    // 2. 避免在 partition() 中执行耗时操作
    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {

        // ❌ 不要这样做：会阻塞发送线程
        // database.query(key);
        // httpClient.call(key);

        // ✅ 正确的做法：基于内存计算
        int numPartitions = cluster.partitionCountForTopic(topic);
        return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
    }

    // 3. 处理异常情况，返回有效分区
    private int handleException(int numPartitions) {
        try {
            // 业务逻辑...
        } catch (Exception e) {
            // 异常时使用默认分区
            return 0;
        }
        return 0;
    }

    // 4. 正确处理 null key
    private int partitionForNullKey(String topic, int numPartitions) {
        // 使用随机或轮询策略
        return ThreadLocalRandom.current().nextInt(numPartitions);
    }
}
```

---

## 5. 粘性分区策略

### 5.1 为什么需要粘性分区

**轮询分区的问题**：

```
轮询策略下的批次形成：
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ msg 1   │ │ msg 2   │ │ msg 3   │ │ msg 4   │
│ tp-0    │ │ tp-1    │ │ tp-2    │ │ tp-0    │
│ pending │ │ pending │ │ pending │ │ pending │
└─────────┘ └─────────┘ └─────────┘ └─────────┘

结果：
- 每个分区只有少数几条消息
- 批次无法达到 batch.size
- 压缩效率低下
- 网络请求频繁
```

**粘性分区的优势**：

```
粘性分区策略下的批次形成：
┌─────────────────────────────────────────┐
│ batch for tp-0                          │
│ ┌─────────┬─────────┬─────────┬────────┐│
│ │ msg 1   │ msg 4   │ msg 5   │ msg 8  ││
│ └─────────┴─────────┴─────────┴────────┘│
│ (full - 可发送)                          │
└─────────────────────────────────────────┘

结果：
- 同一分区的消息聚集在一起
- 批次快速达到 batch.size
- 更好的压缩率
- 更少的发送请求
```

### 5.2 实现原理

```java
/**
 * 粘性分区核心逻辑
 */
public class BuiltInPartitioner {

    // 粘性分区维护
    private final ConcurrentMap<String, TopicPartitionState> partitionStates;

    // 批次统计信息
    private final RecordAccumulator accumulator;

    public int partition(String topic, int clusterPartitionCount) {
        TopicPartitionState state = partitionStates.get(topic);

        if (state == null) {
            // 初始化新的 Topic 状态
            state = new TopicPartitionState(topic, clusterPartitionCount);
            TopicPartitionState existing = partitionStates.putIfAbsent(topic, state);
            state = existing != null ? existing : state;
        }

        return state.getCurrentPartition();
    }

    /**
     * Topic 分区状态
     */
    class TopicPartitionState {
        private final String topic;
        private final int partitionCount;

        // 当前粘性分区
        private volatile int currentPartition;

        // 当前批次已积累的消息数
        private final AtomicInteger currentBatchSize;

        // 上次切换分区时间
        private volatile long lastSwitchTimeMs;

        TopicPartitionState(String topic, int partitionCount) {
            this.topic = topic;
            this.partitionCount = partitionCount;
            // 随机选择初始分区
            this.currentPartition = ThreadLocalRandom.current().nextInt(partitionCount);
            this.currentBatchSize = new AtomicInteger(0);
            this.lastSwitchTimeMs = time.milliseconds();
        }

        int getCurrentPartition() {
            int batchSize = currentBatchSize.incrementAndGet();

            // 检查是否需要切换分区
            if (shouldSwitchPartition(batchSize)) {
                return switchPartition();
            }

            return currentPartition;
        }

        private boolean shouldSwitchPartition(int batchSize) {
            // 条件 1：批次已满（达到 batch.size 阈值）
            if (batchSize >= BATCH_SIZE_THRESHOLD) {
                return true;
            }

            // 条件 2：时间窗口到期
            long elapsed = time.milliseconds() - lastSwitchTimeMs;
            if (elapsed > PARTITION_STICKY_TIME_MS) {
                return true;
            }

            return false;
        }

        private synchronized int switchPartition() {
            // 切换到下一个分区
            currentPartition = (currentPartition + 1) % partitionCount;
            currentBatchSize.set(0);
            lastSwitchTimeMs = time.milliseconds();

            return currentPartition;
        }
    }
}
```

### 5.3 性能优势

**测试对比**（10000 条消息，10 分区）：

| 策略 | 平均批次大小 | 请求数 | 吞吐量 |
|-----|------------|-------|-------|
| 轮询 | 3-5 条 | 2000+ | 中等 |
| 粘性 | 100+ 条 | 100 | 高 |

**优化效果**：

```
linger.ms = 0 时的表现：

轮询策略：
- 每个分区只有 1 条消息就被发送
- 无法形成有效批次

粘性策略：
- 连续发送消息到同一分区
- 快速积累形成完整批次
- 即使 linger.ms=0 也能获得批处理优势
```

---

**上一章**: [04. Producer 元数据管理](./04-metadata-management.md)
**下一章**: [06. Producer 拦截器](./06-interceptors.md)
