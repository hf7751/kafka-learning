# 09. Producer 实战指南

> **本文档导读**
>
> 本文档提供 Kafka Producer 的实战指南，包括完整的代码示例、最佳实践、性能调优和常见问题解决方案。
>
> **预计阅读时间**: 45 分钟
>
> **相关文档**:
> - [01-producer-overview.md](./01-producer-overview.md) - Producer 架构概述
> - [08-producer-config.md](./08-producer-config.md) - 配置详解

---

## 目录
- [1. 快速入门示例](#1-快速入门示例)
- [2. 高级用法示例](#2-高级用法示例)
- [3. 性能调优实战](#3-性能调优实战)
- [4. 错误处理和重试](#4-错误处理和重试)
- [5. 监控和诊断](#5-监控和诊断)

---

## 1. 快速入门示例

### 1.1 最简单的 Producer

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.ProducerConfig;
import java.util.Properties;

public class SimpleProducer {
    public static void main(String[] args) {
        // 1. 配置 Producer
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        
        // 2. 创建 Producer
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            // 3. 发送消息
            ProducerRecord<String, String> record = 
                new ProducerRecord<>("my-topic", "key-1", "Hello Kafka!");
            
            // 4. 同步发送（等待确认）
            producer.send(record).get();
            System.out.println("消息发送成功！");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
```

### 1.2 异步发送带回调

```java
import org.apache.kafka.clients.producer.Callback;
import org.apache.kafka.clients.producer.RecordMetadata;

public class AsyncProducer {
    public static void main(String[] args) throws InterruptedException {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            for (int i = 0; i < 10; i++) {
                ProducerRecord<String, String> record = 
                    new ProducerRecord<>("my-topic", "key-" + i, "消息 " + i);
                
                // 异步发送，带回调
                producer.send(record, new Callback() {
                    @Override
                    public void onCompletion(RecordMetadata metadata, Exception exception) {
                        if (exception != null) {
                            System.err.println("发送失败: " + exception.getMessage());
                        } else {
                            System.out.printf("发送成功: topic=%s, partition=%d, offset=%d%n",
                                metadata.topic(), metadata.partition(), metadata.offset());
                        }
                    }
                });
            }
            
            // 等待所有消息发送完成
            producer.flush();
            Thread.sleep(1000);
        }
    }
}
```

---

## 2. 高级用法示例

### 2.1 自定义分区器

```java
import org.apache.kafka.clients.producer.Partitioner;
import org.apache.kafka.common.Cluster;
import java.util.Map;

public class CustomPartitioner implements Partitioner {
    
    @Override
    public int partition(String topic, Object key, byte[] keyBytes, 
                        Object value, byte[] valueBytes, Cluster cluster) {
        int numPartitions = cluster.partitionsForTopic(topic).size();
        
        // 自定义分区逻辑：按 key 的哈希值分配，但特殊 key 总是到分区 0
        if (key != null && "special-key".equals(key.toString())) {
            return 0;
        }
        
        // 其他 key 使用默认的哈希分区
        return (keyBytes != null) ? 
            Math.abs(Utils.murmur2(keyBytes)) % numPartitions : 
            ThreadLocalRandom.current().nextInt(numPartitions);
    }
    
    @Override
    public void close() {}
    
    @Override
    public void configure(Map<String, ?> configs) {}
}

// 使用自定义分区器
props.put(ProducerConfig.PARTITIONER_CLASS_CONFIG, 
          "com.example.CustomPartitioner");
```

### 2.2 拦截器链

```java
import org.apache.kafka.clients.producer.ProducerInterceptor;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import java.util.Map;

public class TimingInterceptor implements ProducerInterceptor<String, String> {
    
    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // 发送前添加时间戳头
        record.headers().add("send-timestamp", 
            String.valueOf(System.currentTimeMillis()).getBytes());
        return record;
    }
    
    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        // 收到确认时计算延迟
        if (metadata != null) {
            long sendTime = Long.parseLong(
                new String(metadata.headers().lastHeader("send-timestamp").value()));
            long latency = System.currentTimeMillis() - sendTime;
            System.out.println("发送延迟: " + latency + "ms");
        }
    }
    
    @Override
    public void close() {}
    
    @Override
    public void configure(Map<String, ?> configs) {}
}

// 使用拦截器
props.put(ProducerConfig.INTERCEPTOR_CLASSES_CONFIG, 
          "com.example.TimingInterceptor");
```

### 2.3 幂等 Producer

```java
Properties props = new Properties();
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");
props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");

// 启用幂等性
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");
// 必须设置 acks=all
props.put(ProducerConfig.ACKS_CONFIG, "all");
// 设置重试次数
props.put(ProducerConfig.RETRIES_CONFIG, Integer.toString(Integer.MAX_VALUE));
// 限制在途请求数（保证顺序）
props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, "5");
```

### 2.4 事务 Producer

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.KafkaException;
import java.util.Properties;

public class TransactionalProducer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        
        // 事务配置
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "my-transactional-id");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.toString(Integer.MAX_VALUE));
        
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            // 初始化事务
            producer.initTransactions();
            
            try {
                // 开始事务
                producer.beginTransaction();
                
                // 在事务中发送多条消息
                for (int i = 0; i < 5; i++) {
                    producer.send(new ProducerRecord<>("topic-A", "key-" + i, "消息 " + i));
                    producer.send(new ProducerRecord<>("topic-B", "key-" + i, "消息 " + i));
                }
                
                // 提交事务
                producer.commitTransaction();
                System.out.println("事务提交成功！");
                
            } catch (KafkaException e) {
                //  abort 事务
                producer.abortTransaction();
                System.err.println("事务 aborted: " + e.getMessage());
                throw e;
            }
        }
    }
}
```

---

## 3. 性能调优实战

### 3.1 高吞吐量配置

```java
Properties props = new Properties();

// 基础配置
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "broker1:9092,broker2:9092");
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");
props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");

// ========== 吞吐量优化 ==========
// 增加批次大小（默认 16KB，建议 32KB-64KB）
props.put(ProducerConfig.BATCH_SIZE_CONFIG, "65536");

// 增加 linger 时间（默认 0，建议 5-20ms）
props.put(ProducerConfig.LINGER_MS_CONFIG, "10");

// 增加缓冲区大小（默认 32MB，建议 64MB-128MB）
props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, "134217728");

// 启用压缩（LZ4 性能最好）
props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");

// 增加最大请求大小（默认 1MB）
props.put(ProducerConfig.MAX_REQUEST_SIZE_CONFIG, "10485760");

// ========== 可靠性配置 ==========
props.put(ProducerConfig.ACKS_CONFIG, "1");  // 等待 Leader 确认
props.put(ProducerConfig.RETRIES_CONFIG, "3");  // 重试 3 次

// ========== 网络优化 ==========
props.put(ProducerConfig.SEND_BUFFER_CONFIG, "131072");  // 128KB
props.put(ProducerConfig.RECEIVE_BUFFER_CONFIG, "131072");  // 128KB
```

### 3.2 低延迟配置

```java
Properties props = new Properties();

// 基础配置
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");
props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringSerializer");

// ========== 低延迟优化 ==========
// 小批次或不批次
props.put(ProducerConfig.BATCH_SIZE_CONFIG, "16384");  // 16KB
props.put(ProducerConfig.LINGER_MS_CONFIG, "0");  // 不等待

// 减少缓冲区大小
props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, "33554432");  // 32MB

// 不压缩或使用 Snappy（速度快）
props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "snappy");

// ========== 可靠性配置 ==========
props.put(ProducerConfig.ACKS_CONFIG, "1");
props.put(ProducerConfig.RETRIES_CONFIG, "1");
```

### 3.3 性能测试脚本

创建 `producer-performance-test.sh`：

```bash
#!/bin/bash

# Kafka 生产者性能测试脚本

KAFKA_HOME="/path/to/kafka"
BOOTSTRAP_SERVERS="localhost:9092"
TOPIC="performance-test-topic"
NUM_RECORDS=1000000
RECORD_SIZE=1024
THROUGHPUT=100000

echo "开始性能测试..."
echo "消息数量: $NUM_RECORDS"
echo "消息大小: $RECORD_SIZE bytes"
echo "目标吞吐量: $THROUGHPUT records/sec"

# 创建测试 Topic（如果不存在）
$KAFKA_HOME/bin/kafka-topics.sh --create \
  --topic $TOPIC \
  --partitions 6 \
  --replication-factor 3 \
  --if-not-exists \
  --bootstrap-server $BOOTSTRAP_SERVERS

# 运行性能测试
$KAFKA_HOME/bin/kafka-producer-perf-test.sh \
  --topic $TOPIC \
  --num-records $NUM_RECORDS \
  --record-size $RECORD_SIZE \
  --throughput $THROUGHPUT \
  --producer-props \
    bootstrap.servers=$BOOTSTRAP_SERVERS \
    acks=all \
    linger.ms=10 \
    batch.size=65536 \
    compression.type=lz4 \
    buffer.memory=134217728

echo "性能测试完成！"
```

---

## 4. 错误处理和重试

### 4.1 常见错误类型

| 错误类型 | 说明 | 处理策略 |
|----------|------|----------|
| **TimeoutException** | 请求超时 | 增加 `request.timeout.ms`，检查网络 |
| **LeaderNotAvailableException** | Leader 不可用 | 等待重新选举，重试 |
| **NotEnoughReplicasException** | 副本不足 | 检查 ISR，减少 `min.insync.replicas` |
| **RecordTooLargeException** | 消息过大 | 增加 `max.request.size` 和 `message.max.bytes` |
| **SerializationException** | 序列化失败 | 检查 Serializer 实现 |
| **BufferExhaustedException** | 缓冲区耗尽 | 增加 `buffer.memory`，或阻塞等待 |

### 4.2 重试策略实现

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.RetriableException;
import java.util.Properties;

public class RetryProducer {
    private static final int MAX_RETRIES = 3;
    private static final long RETRY_BACKOFF_MS = 1000;
    
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.RETRIES_CONFIG, "0");  // 禁用自动重试，手动控制
        
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            ProducerRecord<String, String> record = 
                new ProducerRecord<>("my-topic", "key", "value");
            
            sendWithRetry(producer, record, MAX_RETRIES);
            
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    
    private static void sendWithRetry(KafkaProducer<String, String> producer,
                                     ProducerRecord<String, String> record,
                                     int maxRetries) throws Exception {
        int attempts = 0;
        
        while (true) {
            try {
                producer.send(record).get();
                System.out.println("发送成功");
                return;
            } catch (Exception e) {
                attempts++;
                
                // 检查是否是可重试异常
                if (e.getCause() instanceof RetriableException && attempts < maxRetries) {
                    System.out.printf("发送失败（尝试 %d/%d），%dms 后重试...%n",
                        attempts, maxRetries, RETRY_BACKOFF_MS);
                    Thread.sleep(RETRY_BACKOFF_MS);
                } else {
                    // 不可重试或超过重试次数
                    throw e;
                }
            }
        }
    }
}
```

---

## 5. 监控和诊断

### 5.1 关键监控指标

| 指标名称 | 说明 | 告警阈值 |
|----------|------|----------|
| `record-send-rate` | 每秒发送记录数 | 根据业务期望 |
| `record-error-rate` | 每秒错误数 | > 0 |
| `request-latency-avg` | 平均请求延迟 | > 100ms |
| `request-latency-max` | 最大请求延迟 | > 1000ms |
| `outgoing-byte-rate` | 每秒发送字节数 | 接近网络带宽 |
| `buffer-available-bytes` | 可用缓冲区 | < 10% |
| `batch-size-avg` | 平均批次大小 | < 4KB |
| `compression-rate-avg` | 平均压缩率 | < 0.5 |

### 5.2 JMX 监控配置

启用 JMX 监控：

```bash
export JMX_PORT=9999
export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote=true \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false \
  -Djava.rmi.server.hostname=your-host"

# 启动应用
java -jar your-app.jar
```

使用 JConsole 连接查看指标。

### 5.3 日志诊断配置

在 `log4j2.properties` 中添加：

```properties
# Producer 调试日志
logger.producer.name = org.apache.kafka.clients.producer
logger.producer.level = DEBUG

# 请求日志
logger.request.name = org.apache.kafka.clients.producer.internals.Sender
logger.request.level = DEBUG

# 网络日志
logger.network.name = org.apache.kafka.common.network
logger.network.level = DEBUG
```

---

## 6. 最佳实践清单

### 6.1 开发最佳实践

- ✅ 始终使用 try-with-resources 管理 Producer 生命周期
- ✅ 为 Producer 设置合理的 client.id
- ✅ 实现适当的错误处理和重试逻辑
- ✅ 使用异步发送 + 回调提高吞吐量
- ✅ 考虑使用拦截器进行横切关注点处理

### 6.2 生产部署最佳实践

- ✅ 配置多个 bootstrap.servers 提高可用性
- ✅ 根据业务需求选择合适的 acks 级别
- ✅ 监控关键指标并设置告警
- ✅ 合理配置批次大小和 linger 时间
- ✅ 使用压缩减少网络和存储开销
- ✅ 启用幂等性避免重复（如需要）
- ✅ 使用事务保证原子性（如需要）

### 6.3 安全最佳实践

- ✅ 使用 SSL/TLS 加密数据传输
- ✅ 使用 SASL 进行身份认证
- ✅ 配置 ACL 限制访问权限
- ✅ 定期轮换凭证和证书
- ✅ 审计敏感操作日志

---

**下一篇**: [10. Consumer 消费者详解](../10-consumer/README.md)
