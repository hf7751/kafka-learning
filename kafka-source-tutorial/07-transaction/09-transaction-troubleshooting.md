# 09. 事务故障排查

## 本章导读

本章介绍 Kafka 事务的常见问题、诊断方法、故障恢复以及最佳实践，帮助你快速定位和解决事务相关的问题。

---

## 1. 常见问题

### 1.1 ProducerFencedException

```java
/**
 * 问题: ProducerFencedException
 *
 * 现象:
 * - 生产者发送消息时抛出异常
 * - 异常信息: "Producer is fenced"
 *
 * 原因:
 * 1. 有新的 Producer 使用相同的 transactional.id
 * 2. 新 Producer 递增了 Epoch
 * 3. 旧 Producer 的请求被拒绝
 */

// 示例代码
try {
    producer.send(new ProducerRecord<>("topic", "key", "value")).get();
} catch (ProducerFencedException e) {
    log.error("Producer 被隔离", e);
    /**
     * 解决方案:
     * 1. 关闭当前 Producer
     * 2. 重新创建 Producer
     * 3. 重新初始化事务
     */
    producer.close();
    producer = createNewProducer();
    producer.initTransactions();
}

// 预防措施
// 1. 避免多个实例使用相同的 transactional.id
// 2. 使用实例唯一标识符，如 Pod 名称
// 3. 实现优雅关闭，避免强制重启
String transactionalId = "order-processor-" + podName;
```

### 1.2 OutOfOrderSequenceException

```java
/**
 * 问题: OutOfOrderSequenceException
 *
 * 现象:
 * - 生产者发送消息时抛出异常
 * - 异常信息: "Out of order sequence number"
 *
 * 原因:
 * 1. 网络重试导致序列号混乱
 * 2. Producer 重启但序列号状态丢失
 * 3. 多线程并发发送
 */

// 示例代码
try {
    producer.send(new ProducerRecord<>("topic", "key", "value")).get();
} catch (OutOfOrderSequenceException e) {
    log.error("序列号错误", e);
    /**
     * 解决方案:
     * 1. 关闭当前 Producer
     * 2. 重新创建 Producer
     * 3. 重新初始化事务
     */
    producer.close();
    producer = createNewProducer();
    producer.initTransactions();
}

// 预防措施
// 1. 配置合理的重试策略
props.put("retries", "3");
props.put("max.in.flight.requests.per.connection", "1");

// 2. 避免多线程并发发送
// 使用单个线程发送，或使用 synchronized
synchronized (producer) {
    producer.send(record);
}

// 3. 实现幂等性处理
// 即使消息重复，也不会影响业务逻辑
```

### 1.3 TransactionTimeoutException

```java
/**
 * 问题: TransactionTimeoutException
 *
 * 现象:
 * - 提交事务时抛出异常
 * - 异常信息: "Transaction timeout"
 *
 * 原因:
 * 1. 事务执行时间过长
 * 2. 超过 transaction.timeout.ms 配置
 * 3. Broker 端已回滚事务
 */

// 示例代码
try {
    producer.beginTransaction();

    // 执行长时间操作
    longOperation();

    producer.commitTransaction();
} catch (TransactionTimeoutException e) {
    log.error("事务超时", e);
    /**
     * 解决方案:
     * 1. 检查事务超时配置
     * 2. 优化事务执行时间
     * 3. 分批处理
     */
}

// 预防措施
// 1. 增加事务超时时间
props.put("transaction.timeout.ms", "300000");  // 5分钟

// 2. 分批处理
List<List<Record>> batches = partitionIntoBatches(records, 1000);
for (List<Record> batch : batches) {
    producer.beginTransaction();
    for (Record record : batch) {
        producer.send(record);
    }
    producer.commitTransaction();
}

// 3. 监控事务执行时间
long startTime = System.currentTimeMillis();
producer.beginTransaction();
// ... 发送消息
producer.commitTransaction();
long duration = System.currentTimeMillis() - startTime;
if (duration > timeout * 0.8) {
    log.warn("事务执行时间接近超时: {}ms", duration);
}
```

### 1.4 InvalidProducerEpochException

```java
/**
 * 问题: InvalidProducerEpochException
 *
 * 现象:
 * - 发送消息或提交事务时抛出异常
 * - 异常信息: "Invalid producer epoch"
 *
 * 原因:
 * 1. Producer Epoch 与 Broker 端不匹配
 * 2. Producer 被隔离后继续使用
 * 3. Broker 故障恢复后状态不一致
 */

// 示例代码
try {
    producer.send(new ProducerRecord<>("topic", "key", "value")).get();
} catch (InvalidProducerEpochException e) {
    log.error("Producer Epoch 无效", e);
    /**
     * 解决方案:
     * 1. 关闭当前 Producer
     * 2. 重新初始化事务（会获取新 Epoch）
     * 3. 重新发送消息
     */
    producer.close();
    producer = createNewProducer();
    producer.initTransactions();
}

// 诊断步骤
// 1. 检查日志，确认 Epoch 是否递增
// 2. 检查是否有其他实例使用相同 transactional.id
// 3. 检查 Broker 故障恢复日志
```

---

## 2. 诊断工具

### 2.1 日志分析

```bash
# 1. Producer 日志
# 查看事务相关日志
grep "transaction" /path/to/producer.log | tail -100

# 查看错误日志
grep "ERROR" /path/to/producer.log | grep -i "transaction"

# 2. Broker 日志
# 查找 TransactionCoordinator 日志
grep "TransactionCoordinator" /path/to/broker.log | tail -100

# 查找事务超时日志
grep "Transaction timed out" /path/to/broker.log

# 查找 Producer Fence 日志
grep "ProducerId fence" /path/to/broker.log
```

### 2.2 JMX 指标查询

```bash
# 1. 查看活跃事务数
jconsole localhost:9999
# 导航到: kafka.coordinator.transaction:type=TransactionCoordinator
# 查看: ActiveTransactionCount

# 2. 使用 jmxterm
java -jar jmxterm.jar -l localhost:9999
> bean kafka.coordinator.transaction:type=TransactionCoordinator
> get ActiveTransactionCount

# 3. 查看事务错误
> bean kafka.producer:type=producer-metrics,client-id=*
> get tx-abort-total
> get tx-error-total
```

### 2.3 事务状态查询

```bash
# 使用 kafka-transactions.sh

# 1. 查看事务状态
bin/kafka-transactions.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --transactional-id "order-processor-1"

# 输出示例:
# TransactionalId: order-processor-1
# ProducerId: 1001
# ProducerEpoch: 5
# State: CompleteCommit
# TopicPartitions: orders-0, validated-1

# 2. 查找所有未完成的事务
bin/kafka-transactions.sh \
  --bootstrap-server localhost:9092 \
  --list \
  --state Ongoing
```

---

## 3. 故障场景

### 3.1 网络分区

```scala
/**
 * 场景: 网络分区
 *
 * 问题:
 * 1. Producer 与 Broker 网络中断
 * 2. 请求超时
 * 3. Producer 重试
 *
 * 影响:
 * 1. 可能产生重复消息（幂等性保证不会重复）
 * 2. 事务可能超时
 * 3. Producer 可能被隔离
 */

// 诊断
// 1. 检查网络连通性
ping broker-host

// 2. 检查端口连通性
telnet broker-host 9092

// 3. 检查 Kafka 连接状态
bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092

// 解决方案
// 1. 配置合理的超时时间
props.put("request.timeout.ms", "30000");  // 30秒
props.put("transaction.timeout.ms", "60000");  // 60秒

// 2. 配置重试策略
props.put("retries", "5");
props.put("retry.backoff.ms", "100");

// 3. 实现重试逻辑
int retries = 0;
while (retries < maxRetries) {
    try {
        producer.beginTransaction();
        // ... 发送消息
        producer.commitTransaction();
        break;
    } catch (NetworkException e) {
        retries++;
        if (retries >= maxRetries) {
            producer.abortTransaction();
            throw e;
        }
        Thread.sleep(1000 * retries);
    }
}
```

### 3.2 Broker 故障

```scala
/**
 * 场景: Broker 故障
 *
 * 问题:
 * 1. TransactionCoordinator 所在 Broker 挂掉
 * 2. 新 Coordinator 选举
 * 3. 事务状态恢复
 *
 * 影响:
 * 1. 短暂的不可用
 * 2. 未完成的事务会恢复
 * 3. Producer 可能需要重试
 */

// 诊断
// 1. 检查 Broker 状态
bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092

// 2. 查看 Controller 状态
bin/kafka-metadata-shell.sh --snapshot /tmp/kafka-meta

// 解决方案
// 1. 配置多个 Broker
// 2. 使用副本机制
// 3. Producer 实现重试

// 事务恢复流程
// 1. 新 Coordinator 加载 __transaction_state
// 2. 检测到未完成的事务（PrepareCommit/Abort）
// 3. 自动发送 Transaction Marker
// 4. 完成未完成的事务
```

### 3.3 磁盘满

```scala
/**
 * 场景: 磁盘满
 *
 * 问题:
 * 1. 无法写入事务日志
 * 2. __transaction_state 写入失败
 * 3. 事务无法提交
 *
 * 影响:
 * 1. 所有事务失败
 * 2. Producer 无法发送消息
 */

// 诊断
// 1. 检查磁盘使用
df -h /path/to/kafka/data

// 2. 检查日志分段大小
ls -lh /path/to/kafka/data/__transaction_state-0/

// 解决方案
// 1. 清理旧数据
bin/kafka-delete-records.sh \
  --bootstrap-server localhost:9092 \
  --offset-json-file offsets.json

// offsets.json:
{
  "partitions": [
    {
      "topic": "__transaction_state",
      "partition": 0,
      "offset": 10000
    }
  ]
}

// 2. 增加磁盘容量
// 3. 配置日志清理
log.retention.hours=168  // 7天
log.segment.bytes=1073741824  // 1GB
```

---

## 4. 性能问题

### 4.1 事务延迟高

```scala
/**
 * 问题: 事务延迟高
 *
 * 症状:
 * 1. 事务提交耗时 > 1秒
 * 2. 吞吐量低
 * 3. 消息积压
 */

// 诊断
// 1. 检查 Transaction Marker 发送延迟
jconsole
# 查看: TransactionMarkerSendLatency

// 2. 检查 __transaction_state 写入延迟
# 查看: TransactionLogAppendLatency

// 3. 检查网络延迟
ping broker-host

// 解决方案
// 1. 增大批量大小
props.put("batch.size", "32768");  // 32KB
props.put("linger.ms", "10");  // 10ms

// 2. 优化事务大小
// 减少单个事务的消息数量
List<List<Record>> batches = partitionIntoBatches(records, 500);

// 3. 优化磁盘 I/O
# 使用 SSD
# 增加磁盘 I/O 带宽
# 优化文件系统
```

### 4.2 吞吐量低

```scala
/**
 * 问题: 吞吐量低
 *
 * 症状:
 * 1. TPS < 100
 * 2. 消息积压
 * 3. 消费者延迟高
 */

// 诊断
// 1. 检查活跃事务数
jconsole
# 查看: ActiveTransactionCount

// 2. 检查事务提交速率
# 查看: TransactionCommitRate

// 3. 检查网络带宽
iftop

// 解决方案
// 1. 增加 Partition 数量
// 2. 增加 Broker 数量
// 3. 优化事务大小
// 4. 使用多个 Producer
```

---

## 5. 数据一致性

### 5.1 消息丢失

```scala
/**
 * 问题: 消息丢失
 *
 * 症状:
 * 1. 消息数量不对
 * 2. 数据不一致
 */

// 诊断
// 1. 检查事务日志
bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic __transaction_state \
  --from-beginning

// 2. 检查消息数量
bin/kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 \
  --topic orders

// 3. 检查事务状态
bin/kafka-transactions.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --transactional-id "order-processor-1"

// 解决方案
// 1. 确保 acks=all
props.put("acks", "all");

// 2. 确保副本因子 >= 3
# server.properties
default.replication.factor=3
min.insync.replicas=2

// 3. 禁用_unclean.leader.election.enable
unclean.leader.election.enable=false
```

### 5.2 消息重复

```scala
/**
 * 问题: 消息重复
 *
 * 症状:
 * 1. 消息数量多于预期
 * 2. 消费者处理重复消息
 */

// 诊断
// 1. 检查幂等性配置
# 确保启用
props.put("enable.idempotence", "true");

// 2. 检查事务日志
# 查找重复的事务

// 3. 检查消费者逻辑
# 确保消费者正确处理

// 解决方案
// 1. 启用幂等性
props.put("enable.idempotence", "true");

// 2. 使用事务
props.put("transactional.id", "unique-id");

// 3. 消费者实现幂等性
# 使用业务键去重
if (!processedKeys.contains(record.key())) {
    process(record);
    processedKeys.add(record.key());
}
```

---

## 6. 最佳实践

### 6.1 预防措施

```java
/**
 * 预防性配置
 */

Properties props = new Properties();

// 1. 合理的超时配置
props.put("request.timeout.ms", "30000");
props.put("transaction.timeout.ms", "60000");

// 2. 启用重试
props.put("retries", "3");
props.put("retry.backoff.ms", "100");

// 3. 启用幂等性
props.put("enable.idempotence", "true");

// 4. 配置 ACK
props.put("acks", "all");

// 5. 限制并发请求
props.put("max.in.flight.requests.per.connection", "1");

// 6. 合理的批量大小
props.put("batch.size", "16384");
props.put("linger.ms", "5");
```

### 6.2 监控告警

```yaml
# Prometheus 告警规则
groups:
  - name: kafka_transaction_alerts
    rules:
      # 事务成功率告警
      - alert: LowTransactionSuccessRate
        expr: |
          rate(kafka_producer_tx_commit[5m]) /
          (rate(kafka_producer_tx_commit[5m]) + rate(kafka_producer_tx_abort[5m]))
          < 0.95
        for: 5m

      # 事务延迟告警
      - alert: HighTransactionLatency
        expr: |
          histogram_quantile(0.95,
            rate(kafka_producer_tx_commit_latency_bucket[5m])
          ) > 1000
        for: 5m
```

---

## 7. 总结

### 7.1 常见问题

1. **ProducerFencedException**
   - 原因: transactional.id 冲突
   - 解决: 重新创建 Producer

2. **TransactionTimeoutException**
   - 原因: 事务执行时间过长
   - 解决: 增加超时时间或分批处理

3. **性能问题**
   - 原因: 配置不当或资源不足
   - 解决: 优化配置或扩容

### 7.2 诊断工具

1. **日志分析**
   - Producer 日志
   - Broker 日志

2. **JMX 指标**
   - 事务成功率
   - 延迟分布

3. **命令行工具**
   - kafka-transactions.sh
   - kafka-console-consumer.sh

### 7.3 下一步学习

- **[10-transaction-config.md](./10-transaction-config.md)** - 学习配置优化
- **[11-transaction-patterns.md](./11-transaction-patterns.md)** - 了解最佳实践

---

**思考题**：
1. 如何区分 Producer Fence 是正常重启还是异常情况？
2. 事务超时后，消息是否已经持久化？如何验证？
3. 如何设计一个自动诊断系统？
