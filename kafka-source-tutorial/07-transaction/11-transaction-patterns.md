# 11. 事务模式与最佳实践

## 本章导读

本章介绍 Kafka 事务的常见应用模式、 Exactly-Once 语义的实现、性能优化建议以及生产环境的最佳实践。

---

## 1. Exactly-Once 语义

### 1.1 语义层次

```scala
/**
 * 消息传递语义
 *
 * 1. At-Most-Once (最多一次)
 *    - 消息可能丢失
 *    - 但不会重复
 *    - 配置: acks=0
 *
 * 2. At-Least-Once (至少一次)
 *    - 消息不会丢失
 *    - 但可能重复
 *    - 配置: acks=1 或 all
 *    - 消费者需要去重
 *
 * 3. Exactly-Once (精确一次)
 *    - 消息不丢失
 *    - 消息不重复
 *    - 配置: enable.idempotence=true
 *    - 或使用事务
 */
```

### 1.2 端到端 Exactly-Once

```java
/**
 * 端到端 Exactly-Once 实现
 *
 * 要求:
 * 1. 生产者幂等性
 * 2. 事务保证跨分区原子性
 * 3. 消费者隔离级别
 * 4. 消费-生产事务
 */

// 完整示例
public class ExactlyOnceProcessor {
    private final KafkaConsumer<String, String> consumer;
    private final KafkaProducer<String, String> producer;

    public ExactlyOnceProcessor() {
        // 消费者配置
        Properties consumerProps = new Properties();
        consumerProps.put("bootstrap.servers", "localhost:9092");
        consumerProps.put("group.id", "exactly-once-processor");
        consumerProps.put("enable.auto.commit", "false");
        consumerProps.put("isolation.level", "read_committed");
        
        this.consumer = new KafkaConsumer<>(consumerProps);

        // 生产者配置
        Properties producerProps = new Properties();
        producerProps.put("bootstrap.servers", "localhost:9092");
        producerProps.put("transactional.id", "exactly-once-processor-1");
        producerProps.put("acks", "all");
        
        this.producer = new KafkaProducer<>(producerProps);
        
        // 初始化事务
        producer.initTransactions();
    }

    public void process() {
        consumer.subscribe(Arrays.asList("input-topic"));

        while (true) {
            // 1. 消费消息
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));
            
            if (records.isEmpty()) {
                continue;
            }

            // 2. 开启事务
            producer.beginTransaction();

            try {
                // 3. 处理并发送
                Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                
                for (ConsumerRecord<String, String> record : records) {
                    // 处理消息
                    String result = transform(record.value());
                    
                    // 发送结果
                    producer.send(new ProducerRecord<>("output-topic", record.key(), result));
                    
                    // 记录 offset
                    offsets.put(
                        new TopicPartition(record.topic(), record.partition()),
                        new OffsetAndMetadata(record.offset() + 1)
                    );
                }

                // 4. 提交 offset 到事务
                producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());

                // 5. 提交事务
                producer.commitTransaction();

            } catch (Exception e) {
                // 6. 回滚事务
                producer.abortTransaction();
                log.error("事务处理失败", e);
            }
        }
    }

    private String transform(String value) {
        // 业务逻辑
        return value.toUpperCase();
    }
}
```

---

## 2. 常见事务模式

### 2.1 单生产者事务

```java
/**
 * 模式: 单生产者事务
 *
 * 场景:
 * - 单个生产者写入多个分区
 * - 保证跨分区原子性
 */

public class SingleProducerTransaction {
    public void process() {
        KafkaProducer<String, String> producer = createTransactionalProducer();

        producer.beginTransaction();

        try {
            // 写入多个分区
            producer.send(new ProducerRecord<>("orders-1", "order-1"));
            producer.send(new ProducerRecord<>("orders-2", "order-2"));
            producer.send(new ProducerRecord<>("orders-3", "order-3"));

            producer.commitTransaction();

        } catch (Exception e) {
            producer.abortTransaction();
        }
    }
}
```

### 2.2 消费-生产事务

```java
/**
 * 模式: 消费-生产事务 (Consume-Transform-Produce)
 *
 * 场景:
 * - 从一个 Topic 读取
 * - 处理后写入另一个 Topic
 * - 实现 Exactly-Once
 */

public class ConsumeProduceTransaction {
    public void process() {
        KafkaConsumer<String, String> consumer = createConsumer();
        KafkaProducer<String, String> producer = createTransactionalProducer();

        consumer.subscribe(Arrays.asList("input-topic"));

        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));

            if (records.isEmpty()) {
                continue;
            }

            producer.beginTransaction();

            try {
                Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();

                for (ConsumerRecord<String, String> record : records) {
                    // 处理消息
                    String result = process(record.value());

                    // 发送结果
                    producer.send(new ProducerRecord<>("output-topic", result));

                    // 记录 offset
                    offsets.put(
                        new TopicPartition(record.topic(), record.partition()),
                        new OffsetAndMetadata(record.offset() + 1)
                    );
                }

                // 提交 offset 到事务
                producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());

                // 提交事务
                producer.commitTransaction();

            } catch (Exception e) {
                producer.abortTransaction();
            }
        }
    }
}
```

### 2.3 多输出流事务

```java
/**
 * 模式: 多输出流事务
 *
 * 场景:
 * - 根据条件路由到不同 Topic
 * - 保证所有写入原子性
 */

public class MultiOutputTransaction {
    public void process() {
        KafkaProducer<String, String> producer = createTransactionalProducer();

        producer.beginTransaction();

        try {
            ConsumerRecord<String, String> record = consume();

            // 处理消息
            String result = process(record.value());

            // 根据条件路由
            if (isValid(result)) {
                producer.send(new ProducerRecord<>("valid-orders", result));
            } else {
                producer.send(new ProducerRecord<>("invalid-orders", result));
            }

            // 记录审计日志
            producer.send(new ProducerRecord<>("audit-log", result));

            producer.commitTransaction();

        } catch (Exception e) {
            producer.abortTransaction();
        }
    }
}
```

### 2.4 分区级事务

```java
/**
 * 模式: 分区级事务
 *
 * 场景:
 * - 每个分区独立事务
 * - 提高并发度
 */

public class PartitionLevelTransaction {
    public void process() {
        KafkaConsumer<String, String> consumer = createConsumer();
        KafkaProducer<String, String> producer = createTransactionalProducer();

        consumer.subscribe(Arrays.asList("input-topic"));

        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));

            if (records.isEmpty()) {
                continue;
            }

            // 按分区分组
            Map<TopicPartition, List<ConsumerRecord<String, String>>> partitionedRecords =
                records.recordsByPartitions();

            // 每个分区独立事务
            for (Map.Entry<TopicPartition, List<ConsumerRecord<String, String>>> entry : 
                    partitionedRecords.entrySet()) {

                TopicPartition partition = entry.getKey();
                List<ConsumerRecord<String, String>> partitionRecords = entry.getValue();

                producer.beginTransaction();

                try {
                    for (ConsumerRecord<String, String> record : partitionRecords) {
                        String result = process(record.value());
                        producer.send(new ProducerRecord<>("output-topic", result));
                    }

                    // 提交该分区的 offset
                    Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                    offsets.put(
                        partition,
                        new OffsetAndMetadata(partitionRecords.get(partitionRecords.size() - 1).offset() + 1)
                    );
                    producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());

                    producer.commitTransaction();

                } catch (Exception e) {
                    producer.abortTransaction();
                }
            }
        }
    }
}
```

---

## 3. 性能优化模式

### 3.1 批量事务

```java
/**
 * 模式: 批量事务
 *
 * 优势:
 * - 减少事务开销
 * - 提高吞吐量
 */

public class BatchTransaction {
    private static final int BATCH_SIZE = 1000;

    public void process() {
        KafkaConsumer<String, String> consumer = createConsumer();
        KafkaProducer<String, String> producer = createTransactionalProducer();

        consumer.subscribe(Arrays.asList("input-topic"));

        List<ConsumerRecord<String, String>> batch = new ArrayList<>(BATCH_SIZE);

        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));

            batch.addAll(records.records("input-topic"));

            if (batch.size() >= BATCH_SIZE) {
                processBatch(batch, producer, consumer);
                batch.clear();
            }
        }
    }

    private void processBatch(List<ConsumerRecord<String, String>> batch,
                             KafkaProducer<String, String> producer,
                             KafkaConsumer<String, String> consumer) {
        producer.beginTransaction();

        try {
            Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();

            for (ConsumerRecord<String, String> record : batch) {
                String result = process(record.value());
                producer.send(new ProducerRecord<>("output-topic", result));

                // 记录 offset
                offsets.put(
                    new TopicPartition(record.topic(), record.partition()),
                    new OffsetAndMetadata(record.offset() + 1)
                );
            }

            producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());
            producer.commitTransaction();

        } catch (Exception e) {
            producer.abortTransaction();
        }
    }
}
```

### 3.2 并行事务

```java
/**
 * 模式: 并行事务
 *
 * 优势:
 * - 提高并发度
 * - 利用多核
 */

public class ParallelTransaction {
    private final ExecutorService executor;
    private final int numThreads;

    public ParallelTransaction(int numThreads) {
        this.numThreads = numThreads;
        this.executor = Executors.newFixedThreadPool(numThreads);
    }

    public void process() {
        for (int i = 0; i < numThreads; i++) {
            final int threadId = i;
            executor.submit(() -> {
                KafkaConsumer<String, String> consumer = createConsumer();
                KafkaProducer<String, String> producer = createTransactionalProducer(
                    "processor-" + threadId
                );

                processSingleThread(consumer, producer);
            });
        }
    }

    private void processSingleThread(KafkaConsumer<String, String> consumer,
                                    KafkaProducer<String, String> producer) {
        // 单线程处理逻辑
        // ...
    }
}
```

### 3.3 管道事务

```java
/**
 * 模式: 管道事务
 *
 * 场景:
 * - 多个处理阶段
 * - 每个阶段独立事务
 */

public class PipelineTransaction {
    public void process() {
        // 阶段 1: 验证
        KafkaProducer<String, String> validator = createProducer("validator");
        validateAndProduce(validator);

        // 阶段 2: 转换
        KafkaProducer<String, String> transformer = createProducer("transformer");
        transformAndProduce(transformer);

        // 阶段 3: 聚合
        KafkaProducer<String, String> aggregator = createProducer("aggregator");
        aggregateAndProduce(aggregator);
    }
}
```

---

## 4. 错误处理模式

### 4.1 重试模式

```java
/**
 * 模式: 事务重试
 */

public class TransactionRetry {
    private static final int MAX_RETRIES = 3;

    public void processWithRetry() {
        KafkaProducer<String, String> producer = createTransactionalProducer();

        int retries = 0;
        while (retries < MAX_RETRIES) {
            try {
                producer.beginTransaction();
                processMessages(producer);
                producer.commitTransaction();
                break; // 成功，退出

            } catch (Exception e) {
                retries++;
                if (retries >= MAX_RETRIES) {
                    producer.abortTransaction();
                    throw new RuntimeException("处理失败，超过最大重试次数", e);
                }
                
                // 等待后重试
                Thread.sleep(1000 * retries);
            }
        }
    }
}
```

### 4.2 补偿模式

```java
/**
 * 模式: 补偿事务
 *
 * 场景:
 * - 主事务失败后执行补偿
 * - 保证最终一致性
 */

public class CompensatingTransaction {
    public void process() {
        KafkaProducer<String, String> producer = createTransactionalProducer();

        try {
            // 主事务
            producer.beginTransaction();
            processMain(producer);
            producer.commitTransaction();

        } catch (Exception e) {
            log.error("主事务失败，执行补偿", e);
            
            try {
                // 补偿事务
                producer.beginTransaction();
                processCompensation(producer);
                producer.commitTransaction();

            } catch (Exception ex) {
                producer.abortTransaction();
                throw new RuntimeException("补偿事务失败", ex);
            }
        }
    }

    private void processMain(KafkaProducer<String, String> producer) {
        // 主逻辑
    }

    private void processCompensation(KafkaProducer<String, String> producer) {
        // 补偿逻辑
        // 发送取消消息
        // 回滚状态
    }
}
```

### 4.3 幂等处理

```java
/**
 * 模式: 幂等处理
 *
 * 作用:
 * - 即使消息重复，也不影响结果
 */

public class IdempotentProcessor {
    private final Set<String> processedKeys = ConcurrentHashMap.newKeySet();

    public void process(ConsumerRecord<String, String> record) {
        String key = record.key();

        // 检查是否已处理
        if (processedKeys.contains(key)) {
            log.warn("重复消息，跳过: {}", key);
            return;
        }

        // 处理消息
        processMessage(record);

        // 记录已处理的键
        processedKeys.add(key);

        // 定期清理
        if (processedKeys.size() > 10000) {
            processedKeys.clear();
        }
    }
}
```

---

## 5. 最佳实践

### 5.1 事务大小

```java
/**
 * 最佳实践: 控制事务大小
 *
 * 建议:
 * - 每个事务 100-1000 条消息
 * - 避免大事务
 * - 分批处理
 */

public class TransactionSizing {
    private static final int IDEAL_TX_SIZE = 500;
    private static final int MAX_TX_SIZE = 1000;

    public void process() {
        List<Record> batch = new ArrayList<>(IDEAL_TX_SIZE);

        for (Record record : records) {
            batch.add(record);

            if (batch.size() >= IDEAL_TX_SIZE) {
                processBatch(batch);
                batch.clear();
            }
        }

        // 处理剩余记录
        if (!batch.isEmpty()) {
            processBatch(batch);
        }
    }
}
```

### 5.2 事务 ID 设计

```java
/**
 * 最佳实践: 事务 ID 设计
 *
 * 原则:
 * 1. 包含业务信息
 * 2. 包含实例标识
 * 3. 保持稳定
 */

public class TransactionalIdDesign {
    /**
     * 好的事务 ID
     */
    public static String createGoodId() {
        // 格式: {app}-{component}-{instance}
        String app = "order-service";
        String component = "validator";
        String instance = getPodName();  // 从环境变量获取
        
        return String.format("%s-%s-%s", app, component, instance);
    }

    /**
     * 不好的事务 ID
     */
    public static String createBadId1() {
        // 随机 ID - 每次重启都变化
        return UUID.randomUUID().toString();
    }

    public static String createBadId2() {
        // 时间戳 - 每次重启都变化
        return "tx-" + System.currentTimeMillis();
    }
}
```

### 5.3 错误处理

```java
/**
 * 最佳实践: 错误处理
 */

public class ErrorHandling {
    public void process() {
        try {
            producer.beginTransaction();
            processMessages();
            producer.commitTransaction();

        } catch (ProducerFencedException e) {
            // 必须关闭 Producer
            log.error("Producer 被隔离", e);
            producer.close();
            // 重新创建 Producer

        } catch (OutOfOrderSequenceException e) {
            // 序列号错误，重新创建
            log.error("序列号错误", e);
            producer.close();
            // 重新创建 Producer

        } catch (AuthorizationException e) {
            // 权限错误，不需要回滚
            log.error("权限不足", e);

        } catch (KafkaException e) {
            // 其他异常，回滚事务
            log.error("Kafka 异常", e);
            try {
                producer.abortTransaction();
            } catch (AbortTransactionException ex) {
                log.error("回滚失败", ex);
            }
        }
    }
}
```

### 5.4 监控和告警

```java
/**
 * 最佳实践: 监控和告警
 */

public class TransactionMonitoring {
    private final MeterRegistry meterRegistry;

    public void process() {
        Timer.Sample sample = Timer.start(meterRegistry);

        try {
            producer.beginTransaction();

            // 处理消息
            processMessages();

            producer.commitTransaction();

            // 记录成功指标
            meterRegistry.counter("tx.commit").increment();

        } catch (Exception e) {
            // 记录失败指标
            meterRegistry.counter("tx.abort").increment();
            throw e;

        } finally {
            // 记录延迟
            sample.stop(meterRegistry.timer("tx.latency"));
        }
    }
}
```

---

## 6. 生产环境建议

### 6.1 容量规划

```scala
/**
 * 容量规划
 */

object CapacityPlanning {
    /**
     * 1. 估算 TPS
     * - 每秒事务数量
     * - 峰值流量
     */

    /**
     * 2. 估算延迟
     * - P50: 100ms
     * - P95: 500ms
     * - P99: 1000ms
     */

    /**
     * 3. 估算资源
     * - CPU: 每个 TPS 约 0.01 核心
     * - 内存: 每个 Producer 约 100MB
     * - 网络: 每条消息约 1KB
     * - 磁盘: 根据保留时间计算
     */

    /**
     * 4. 容量公式
     */
    def estimateCapacity(tps: Double, avgMsgSize: Int): Capacity = {
        val networkBandwidth = tps * avgMsgSize * 8  // bps
        val diskIOPS = tps * 3  // 考虑副本
        
        Capacity(
            tps = tps,
            networkBandwidth = networkBandwidth,
            diskIOPS = diskIOPS
        )
    }
}
```

### 6.2 故障恢复

```scala
/**
 * 故障恢复策略
 */

object DisasterRecovery {
    /**
     * 1. Producer 故障
     * - 自动重启
     * - 使用相同的 transactional.id
     * - initTransactions() 会自动恢复
     */

    /**
     * 2. Broker 故障
     * - 副本自动切换
     * - TransactionCoordinator 重新选举
     * - 未完成的事务自动恢复
     */

    /**
     * 3. 网络分区
     * - 配置合理的超时
     * - 实现重试机制
     * - 监控告警
     */
}
```

---

## 7. 总结

### 7.1 核心模式

1. **Exactly-Once**
   - 生产者幂等性
   - 消费-生产事务
   - 消费者隔离级别

2. **性能优化**
   - 批量事务
   - 并行事务
   - 管道事务

3. **错误处理**
   - 重试模式
   - 补偿模式
   - 幂等处理

### 7.2 最佳实践

1. **控制事务大小**
   - 100-1000 条消息/事务

2. **合理的事务 ID**
   - 包含业务信息
   - 保持稳定

3. **完善的错误处理**
   - 区分异常类型
   - 实现重试机制
   - 记录监控指标

4. **充分的测试**
   - 单元测试
   - 集成测试
   - 压力测试

---

**思考题**：
1. 如何在保证 Exactly-Once 的前提下提高吞吐量？
2. 事务 ID 设计有哪些注意事项？
3. 如何实现跨多个 Kafka 集群的 Exactly-Once？
