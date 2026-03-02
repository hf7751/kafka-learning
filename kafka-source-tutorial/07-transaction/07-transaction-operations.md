# 07. 事务操作

## 本章导读

本章介绍 Kafka 事务的实际操作，包括如何配置生产者、发送事务消息、提交和回滚事务，以及实现消费-生产的 Exactly-Once 语义。

---

## 1. 事务生产者配置

### 1.1 基础配置

```java
/**
 * 事务生产者配置
 */

Properties props = new Properties();

/**
 * 1. 必需配置: 事务 ID
 * - 唯一标识事务生产者
 * - 必须设置
 * - 应该具有业务意义
 */
props.put("transactional.id", "order-processor-1");

/**
 * 2. 必需配置: ACK
 * - 事务要求 acks=all
 * - 确保消息持久化
 */
props.put("acks", "all");

/**
 * 3. 必需配置: 幂等性
 * - 事务自动启用幂等性
 * - 无需显式设置
 */
// enable.idempotence 自动设置为 true

/**
 * 4. 可选配置: 事务超时
 * - 默认: 60000 (1分钟)
 * - 最大: transaction.max.timeout.ms (15分钟)
 */
props.put("transaction.timeout.ms", "60000");

/**
 * 5. 其他配置
 */
props.put("bootstrap.servers", "localhost:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");

/**
 * 创建生产者
 */
KafkaProducer<String, String> producer = new KafkaProducer<>(props);
```

### 1.2 事务 ID 命名规范

```java
/**
 * 事务 ID 命名规范
 */

/**
 * 1. 包含业务信息
 * - 格式: {application}-{component}-{instance}
 * - 示例: "order-service-processor-instance-1"
 */

/**
 * 2. 使用稳定的标识符
 * - 不要使用随机 ID
 * - 不要使用时间戳
 * - 应该在重启后保持不变
 */

// 好的命名
String goodTxId = "order-service-validator-pod-1";

// 不好的命名
String badTxId1 = UUID.randomUUID().toString();  // 随机 ID
String badTxId2 = "order-service-" + System.currentTimeMillis();  // 时间戳
```

---

## 2. 基础事务操作

### 2.1 初始化事务

```java
/**
 * 初始化事务
 * - 必须在使用事务前调用
 * - 分配 Producer ID 和 Epoch
 * - 恢复未完成的事务
 */

KafkaProducer<String, String> producer = new KafkaProducer<>(props);

/**
 * 初始化事务
 */
producer.initTransactions();

log.info("事务生产者初始化完成");
```

### 2.2 发送事务消息

```java
/**
 * 发送事务消息
 */

/**
 * 1. 开启事务
 */
producer.beginTransaction();

try {
    /**
     * 2. 发送消息到多个分区
     */
    List<Future<RecordMetadata>> futures = new ArrayList<>();

    futures.add(producer.send(
        new ProducerRecord<>("orders", "order-1", "value-1")
    ));

    futures.add(producer.send(
        new ProducerRecord<>("orders", "order-2", "value-2")
    ));

    futures.add(producer.send(
        new ProducerRecord<>("validated-orders", "order-3", "value-3")
    ));

    /**
     * 3. 等待所有消息发送完成
     */
    for (Future<RecordMetadata> future : futures) {
        future.get();  // 阻塞等待
    }

    /**
     * 4. 提交事务
     */
    producer.commitTransaction();

    log.info("事务提交成功");

} catch (Exception e) {
    /**
     * 5. 发生异常，回滚事务
     */
    producer.abortTransaction();

    log.error("事务回滚", e);
}
```

### 2.3 事务状态检查

```java
/**
 * 检查事务状态
 */

/**
 * 获取事务状态
 * - 注意: 这是客户端状态
 * - 真实状态在 TransactionCoordinator
 */
try {
    /**
     * 尝试发送消息
     */
    producer.send(new ProducerRecord<>("topic", "key", "value")).get();

} catch (KafkaException e) {
    if (e instanceof ProducerFencedException) {
        /**
         * Producer 被隔离
         * - 有新的 Producer 使用相同的 transactional.id
         * - 当前 Producer 不能再使用
         */
        log.error("Producer 被隔离，需要关闭并重新创建", e);
        producer.close();

    } else if (e instanceof OutOfOrderSequenceException) {
        /**
         * 序列号错误
         * - 可能是网络问题导致
         * - 需要重新创建 Producer
         */
        log.error("序列号错误", e);
        producer.close();

    } else if (e instanceof AuthorizationException) {
        /**
         * 权限错误
         */
        log.error("权限不足", e);
    }
}
```

---

## 3. 消费-生产事务

### 3.1 Exactly-Once 语义

```java
/**
 * 消费-生产事务实现 Exactly-Once
 */

/**
 * 配置消费者
 */
Properties consumerProps = new Properties();
consumerProps.put("bootstrap.servers", "localhost:9092");
consumerProps.put("group.id", "order-processor-group");
consumerProps.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
consumerProps.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
/**
 * 重要: 禁用自动提交
 */
consumerProps.put("enable.auto.commit", "false");

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);

/**
 * 配置生产者
 */
Properties producerProps = new Properties();
producerProps.put("bootstrap.servers", "localhost:9092");
producerProps.put("transactional.id", "order-processor-1");
producerProps.put("acks", "all");

KafkaProducer<String, String> producer = new KafkaProducer<>(producerProps);

/**
 * 初始化生产者
 */
producer.initTransactions();

/**
 * 订阅输入 Topic
 */
consumer.subscribe(Arrays.asList("input-orders"));

try {
    while (true) {
        /**
         * 1. 消费消息
         */
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(1));

        if (records.isEmpty()) {
            continue;
        }

        /**
         * 2. 开启事务
         */
        producer.beginTransaction();

        try {
            /**
             * 3. 处理并发送消息
             */
            for (ConsumerRecord<String, String> record : records) {
                /**
                 * 处理消息
                 */
                String result = processOrder(record.value());

                /**
                 * 发送结果到输出 Topic
                 */
                producer.send(new ProducerRecord<>("output-orders", record.key(), result));
            }

            /**
             * 4. 提交消费 Offset 到事务
             * - 这是最关键的一步
             * - 将消费和生产在同一事务中
             */
            Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
            for (TopicPartition partition : records.partitions()) {
                List<ConsumerRecord<String, String>> partitionRecords = records.records(partition);
                long lastOffset = partitionRecords.get(partitionRecords.size() - 1).offset();
                offsets.put(partition, new OffsetAndMetadata(lastOffset + 1));
            }

            producer.sendOffsetsToTransaction(
                offsets,
                consumer.groupMetadata()
            );

            /**
             * 5. 提交事务
             */
            producer.commitTransaction();

            log.info("事务提交成功，处理了 {} 条消息", records.count());

        } catch (Exception e) {
            /**
             * 6. 发生异常，回滚事务
             */
            producer.abortTransaction();

            log.error("事务处理失败，回滚", e);
        }
    }

} finally {
    /**
     * 7. 关闭消费者和生产者
     */
    consumer.close();
    producer.close();
}

/**
 * 处理订单
 */
private String processOrder(String order) {
    /**
     * 业务逻辑
     */
    return "processed:" + order;
}
```

### 3.2 sendOffsetsToTransaction 原理

```java
/**
 * sendOffsetsToTransaction 的作用
 *
 * 1. 将消费 Offset 加入事务
 *    - Offset 写入 __consumer_offsets
 *    - 该 Topic Partition 也在事务中
 *
 * 2. 保证原子性
 *    - Offset 提交和消息生产在同一事务
 *    - 要么都成功，要么都失败
 *
 * 3. 实现 Exactly-Once
 *    - 消费一次
 *    - 处理一次
 *    - 生产一次
 */
```

---

## 4. 事务超时处理

### 4.1 超时配置

```java
/**
 * 事务超时配置
 */

Properties props = new Properties();

/**
 * 1. 生产者端超时
 * - transaction.timeout.ms
 * - 默认: 60000 (1分钟)
 * - 最大: transaction.max.timeout.ms (15分钟)
 */
props.put("transaction.timeout.ms", "300000");  // 5分钟

/**
 * 2. Broker 端最大超时
 * - transaction.max.timeout.ms
 * - 默认: 900000 (15分钟)
 * - 生产者的超时不能超过此值
 */

/**
 * 3. 事务超时检测
 * - TransactionCoordinator 定期检测
 * - 超时的事务自动回滚
 * - 发送 Abort Marker
 */
```

### 4.2 超时处理

```java
/**
 * 处理事务超时
 */

/**
 * 1. 生产者端处理
 */
try {
    producer.beginTransaction();

    /**
     * 执行长时间操作
     */
    longOperation();

    /**
     * 如果操作时间超过 transaction.timeout.ms
     * 提交时会失败
     */
    producer.commitTransaction();

} catch (TimeoutException e) {
    /**
     * 事务超时
     * - 当前事务已失效
     * - 需要回滚
     */
    log.error("事务超时", e);

    try {
        producer.abortTransaction();
    } catch (AbortTransactionException ex) {
        log.error("回滚失败", ex);
    }
}

/**
 * 2. Broker 端处理
 * - TransactionCoordinator 检测到超时
 * - 自动回滚事务
 * - 发送 Abort Marker
 * - 清理事务状态
 */
```

---

## 5. 事务恢复

### 5.1 生产者恢复

```java
/**
 * 生产者故障恢复
 */

/**
 * 1. 生产者崩溃后重启
 * - 使用相同的 transactional.id
 * - initTransactions() 会:
     * a. 检查是否有未完成的事务
     * b. 如果有，完成或回滚
     * c. 递增 Producer Epoch
     * d. 隔离旧的生产者
 */

KafkaProducer<String, String> producer = new KafkaProducer<>(props);

/**
 * 初始化时会自动恢复
 */
producer.initTransactions();

log.info("生产者恢复完成");
```

### 5.2 事务状态恢复

```java
/**
 * 事务状态恢复流程
 *
 * 1. 生产者重启
 *    - 使用相同的 transactional.id
 *
 * 2. InitProducerId 请求
 *    - 向 TransactionCoordinator 请求 PID/Epoch
 *
 * 3. Coordinator 检查
 *    - 查询 __transaction_state
 *    - 检查是否有未完成的事务
 *
 * 4. 恢复事务
 *    - 如果有 PrepareCommit/Abort 状态
     * - 发送 Transaction Marker
     * - 完成未完成的事务
 *
 * 5. 递增 Epoch
 *    - 返回新的 Epoch
 *    - 隔离旧的生产者
 */
```

---

## 6. 错误处理

### 6.1 常见错误

```java
/**
 * 常见错误处理
 */

try {
    producer.beginTransaction();
    // ... 发送消息
    producer.commitTransaction();

} catch (ProducerFencedException e) {
    /**
     * Producer 被隔离
     * - 有新的 Producer 使用相同的 transactional.id
     * - 当前 Producer 不能再使用
     * - 必须关闭并重新创建
     */
    log.error("Producer 被隔离", e);
    producer.close();
    // 重新创建 Producer

} catch (OutOfOrderSequenceException e) {
    /**
     * 序列号错误
     * - 可能是网络问题导致
     * - 必须关闭并重新创建 Producer
     */
    log.error("序列号错误", e);
    producer.close();

} catch (AuthorizationException e) {
    /**
     * 权限错误
     * - 检查 ACL 配置
     */
    log.error("权限不足", e);

} catch (KafkaException e) {
    /**
     * 其他 Kafka 异常
     * - 回滚事务
     */
    log.error("Kafka 异常", e);
    try {
        producer.abortTransaction();
    } catch (AbortTransactionException ex) {
        log.error("回滚失败", ex);
    }
}
```

### 6.2 重试策略

```java
/**
 * 事务重试策略
 */

/**
 * 1. 自动重试
 * - Kafka Producer 自动重试
 * - 配置 retries 参数
 */
props.put("retries", "3");

/**
 * 2. 手动重试
 */
int maxRetries = 3;
int retryCount = 0;

while (retryCount < maxRetries) {
    try {
        producer.beginTransaction();
        // ... 发送消息
        producer.commitTransaction();
        break;  // 成功，退出循环

    } catch (Exception e) {
        retryCount++;

        if (retryCount >= maxRetries) {
            /**
             * 达到最大重试次数
             * - 回滚事务
             * - 抛出异常
             */
            producer.abortTransaction();
            throw e;
        }

        /**
         * 等待一段时间后重试
         */
        Thread.sleep(1000 * retryCount);
    }
}
```

---

## 7. 最佳实践

### 7.1 事务大小

```java
/**
 * 事务大小建议
 */

/**
 * 1. 控制事务大小
 * - 不要在事务中处理太多消息
 * - 建议: 每个事务处理 100-1000 条消息
 * - 过大的事务:
     * a. 占用大量内存
     * b. 增加超时风险
     * c. 降低并发度
 */

/**
 * 2. 分批处理
 */
List<List<ConsumerRecord<String, String>>> batches = partitionIntoBatches(records, 500);

for (List<ConsumerRecord<String, String>> batch : batches) {
    producer.beginTransaction();

    for (ConsumerRecord<String, String> record : batch) {
        producer.send(new ProducerRecord<>("output", record.value()));
    }

    producer.commitTransaction();
}
```

### 7.2 性能优化

```java
/**
 * 性能优化建议
 */

Properties props = new Properties();

/**
 * 1. 增大批量大小
 */
props.put("batch.size", "32768");  // 32KB

/**
 * 2. 增加 linger 时间
 */
props.put("linger.ms", "10");

/**
 * 3. 增加缓冲区大小
 */
props.put("buffer.memory", "67108864");  // 64MB

/**
 * 4. 调整并发度
 * - 事务要求 max.in.flight.requests.per.connection=1
 * - 但可以增加其他参数
 */
props.put("max.in.flight.requests.per.connection", "1");
```

---

## 8. 监控

### 8.1 关键指标

```java
/**
 * 事务监控指标
 */

/**
 * 1. 事务提交次数
 */
metrics.get("tx-commit-total")

/**
 * 2. 事务回滚次数
 */
metrics.get("tx-abort-total")

/**
 * 3. 事务开始次数
 */
metrics.get("tx-begin-total")

/**
 * 4. 事务超时次数
 */
metrics.get("tx-timeout-total")
```

---

## 9. 总结

### 9.1 核心要点

1. **配置事务生产者**
   - 设置 transactional.id
   - 设置 acks=all
   - 调用 initTransactions()

2. **发送事务消息**
   - beginTransaction()
   - send() 消息
   - commitTransaction() 或 abortTransaction()

3. **消费-生产事务**
   - 使用 sendOffsetsToTransaction()
   - 实现 Exactly-Once 语义

4. **错误处理**
   - ProducerFencedException: 重新创建 Producer
   - OutOfOrderSequenceException: 重新创建 Producer
   - 其他异常: 回滚事务

### 9.2 下一步学习

- **[08-transaction-monitoring.md](./08-transaction-monitoring.md)** - 学习监控指标
- **[09-transaction-troubleshooting.md](./09-transaction-troubleshooting.md)** - 了解故障排查

---

**思考题**：
1. 为什么需要在事务中提交消费 Offset？不提交会怎样？
2. 如果事务提交时网络超时，如何判断事务是否成功？
3. 如何在保证事务正确性的前提下提高吞吐量？
