# 09. Consumer 实战指南

> **本文档导读**
>
> 本文档提供 Kafka Consumer 的实战指南，包括完整的代码示例、最佳实践、性能调优和常见问题解决方案。
>
> **预计阅读时间**: 45 分钟
>
> **相关文档**:
> - [01-consumer-overview.md](./01-consumer-overview.md) - Consumer 架构概述
> - [08-consumer-config.md](./08-consumer-config.md) - 配置详解

---

## 目录
- [1. 快速入门示例](#1-快速入门示例)
- [2. 高级用法示例](#2-高级用法示例)
- [3. 消费模式详解](#3-消费模式详解)
- [4. 性能调优实战](#4-性能调优实战)
- [5. 错误处理和重试](#5-错误处理和重试)
- [6. 监控和诊断](#6-监控和诊断)

---

## 1. 快速入门示例

### 1.1 最简单的 Consumer（消费组模式）

```java
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import java.time.Duration;
import java.util.Collections;
import java.util.Properties;

public class SimpleConsumer {
    public static void main(String[] args) {
        // 1. 配置 Consumer
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        
        // 2. 创建 Consumer
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            // 3. 订阅 Topic
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            // 4. 消费消息循环
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (ConsumerRecord<String, String> record : records) {
                    System.out.printf("收到消息: topic=%s, partition=%d, offset=%d, key=%s, value=%s%n",
                        record.topic(), record.partition(), record.offset(),
                        record.key(), record.value());
                }
            }
        }
    }
}
```

### 1.2 独立消费者模式（手动分配分区）

```java
import org.apache.kafka.common.TopicPartition;
import java.util.Arrays;

public class AssignConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            // 手动分配分区（不使用消费组）
            TopicPartition partition0 = new TopicPartition("my-topic", 0);
            TopicPartition partition1 = new TopicPartition("my-topic", 1);
            consumer.assign(Arrays.asList(partition0, partition1));
            
            // 从特定位置开始消费
            consumer.seek(partition0, 100);  // 从 offset 100 开始
            consumer.seekToBeginning(Arrays.asList(partition1));  // 从头开始
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (ConsumerRecord<String, String> record : records) {
                    System.out.printf("收到消息: %s%n", record.value());
                }
            }
        }
    }
}
```

---

## 2. 高级用法示例

### 2.1 手动提交 Offset

```java
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import java.util.Map;
import java.util.HashMap;

public class ManualCommitConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        
        // 禁用自动提交
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                // 处理消息
                for (ConsumerRecord<String, String> record : records) {
                    processRecord(record);
                }
                
                // 同步提交
                try {
                    consumer.commitSync();
                } catch (Exception e) {
                    System.err.println("提交失败: " + e.getMessage());
                }
            }
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        System.out.println("处理消息: " + record.value());
    }
}
```

### 2.2 异步提交 Offset

```java
import org.apache.kafka.clients.consumer.OffsetCommitCallback;

public class AsyncCommitConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (ConsumerRecord<String, String> record : records) {
                    processRecord(record);
                }
                
                // 异步提交，带回调
                consumer.commitAsync(new OffsetCommitCallback() {
                    @Override
                    public void onComplete(Map<TopicPartition, OffsetAndMetadata> offsets, 
                                          Exception exception) {
                        if (exception != null) {
                            System.err.println("异步提交失败: " + exception.getMessage());
                        } else {
                            System.out.println("异步提交成功: " + offsets);
                        }
                    }
                });
            }
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        // 处理逻辑
    }
}
```

### 2.3 精确处理每条记录并提交

```java
public class ExactlyOnceConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (TopicPartition partition : records.partitions()) {
                    List<ConsumerRecord<String, String>> partitionRecords = 
                        records.records(partition);
                    
                    for (ConsumerRecord<String, String> record : partitionRecords) {
                        processRecord(record);
                    }
                    
                    // 提交每个分区的 offset
                    long lastOffset = partitionRecords.get(partitionRecords.size() - 1).offset();
                    Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                    offsets.put(partition, new OffsetAndMetadata(lastOffset + 1));
                    consumer.commitSync(offsets);
                }
            }
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        // 处理逻辑
    }
}
```

### 2.4 消费者拦截器

```java
import org.apache.kafka.clients.consumer.ConsumerInterceptor;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import java.util.Map;

public class TimingConsumerInterceptor implements ConsumerInterceptor<String, String> {
    
    @Override
    public ConsumerRecords<String, String> onConsume(ConsumerRecords<String, String> records) {
        // 记录消费开始时间
        records.records("my-topic").forEach(record -> 
            System.out.println("消费时间: " + System.currentTimeMillis()));
        return records;
    }
    
    @Override
    public void onCommit(Map<TopicPartition, OffsetAndMetadata> offsets) {
        // 记录提交行为
        System.out.println("提交 offsets: " + offsets);
    }
    
    @Override
    public void close() {}
    
    @Override
    public void configure(Map<String, ?> configs) {}
}

// 使用拦截器
props.put(ConsumerConfig.INTERCEPTOR_CLASSES_CONFIG, 
          "com.example.TimingConsumerInterceptor");
```

---

## 3. 消费模式详解

### 3.1 三种消费模式对比

| 模式 | 特点 | 适用场景 |
|------|------|----------|
| **自动提交** | 简单，按时间间隔自动提交 | 可容忍少量重复消费 |
| **同步提交** | 可靠，等待确认 | 需要严格的消费确认 |
| **异步提交** | 高性能，不阻塞 | 对延迟敏感的场景 |
| **混合提交** | 正常用异步，关闭前用同步 | 兼顾性能和可靠性 |

### 3.2 混合提交模式示例

```java
public class HybridCommitConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            try {
                while (true) {
                    ConsumerRecords<String, String> records = 
                        consumer.poll(Duration.ofMillis(100));
                    
                    for (ConsumerRecord<String, String> record : records) {
                        processRecord(record);
                    }
                    
                    // 正常情况异步提交
                    consumer.commitAsync();
                }
            } catch (Exception e) {
                System.err.println("消费异常: " + e.getMessage());
            } finally {
                try {
                    // 关闭前同步提交，确保不丢
                    consumer.commitSync();
                } finally {
                    consumer.close();
                }
            }
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        // 处理逻辑
    }
}
```

### 3.3 多线程消费示例

```java
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MultiThreadConsumer {
    private static final int THREAD_POOL_SIZE = 4;
    
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        // 创建线程池
        ExecutorService executor = Executors.newFixedThreadPool(THREAD_POOL_SIZE);
        
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (final ConsumerRecord<String, String> record : records) {
                    executor.submit(() -> {
                        processRecord(record);
                    });
                }
                
                // 等待线程处理完成后再提交
                // 实际实现需要更复杂的同步机制
                consumer.commitAsync();
            }
        } finally {
            executor.shutdown();
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        // 处理逻辑
    }
}
```

---

## 4. 性能调优实战

### 4.1 高吞吐量配置

```java
Properties props = new Properties();

// 基础配置
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "broker1:9092,broker2:9092");
props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringDeserializer");
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringDeserializer");

// ========== 吞吐量优化 ==========
// 增加每次拉取的最小字节数（默认 1 字节）
props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1024");

// 增加最大等待时间（默认 500ms）
props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "500");

// 增加每次拉取的最大字节数（默认 50MB）
props.put(ConsumerConfig.FETCH_MAX_BYTES_CONFIG, "104857600");

// 增加每个分区的最大拉取字节数（默认 1MB）
props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, "1048576");

// 增加每次 poll 的最大记录数（默认 500）
props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "1000");

// 增加会话超时（默认 45s）
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "60000");

// 增加两次 poll 之间的最大间隔（默认 5 分钟）
props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, "300000");

// ========== 网络优化 ==========
props.put(ConsumerConfig.SEND_BUFFER_CONFIG, "131072");  // 128KB
props.put(ConsumerConfig.RECEIVE_BUFFER_CONFIG, "131072");  // 128KB

// 禁用自动提交，手动控制
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
```

### 4.2 低延迟配置

```java
Properties props = new Properties();

// 基础配置
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringDeserializer");
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
          "org.apache.kafka.common.serialization.StringDeserializer");

// ========== 低延迟优化 ==========
// 不等待数据积累
props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, "1");

// 减少等待时间
props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, "100");

// 减少每次 poll 的记录数
props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "100");

// 缩短会话超时，更快检测失败
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, "10000");

// 缩短心跳间隔
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, "3000");

// 更快的自动提交
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "true");
props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, "1000");
```

### 4.3 性能测试脚本

创建 `consumer-performance-test.sh`：

```bash
#!/bin/bash

# Kafka 消费者性能测试脚本

KAFKA_HOME="/path/to/kafka"
BOOTSTRAP_SERVERS="localhost:9092"
TOPIC="performance-test-topic"
GROUP_ID="performance-test-group"
NUM_MESSAGES=1000000
THREADS=4

echo "开始消费者性能测试..."
echo "消费 Topic: $TOPIC"
echo "消费组: $GROUP_ID"
echo "目标消息数: $NUM_MESSAGES"
echo "线程数: $THREADS"

# 运行性能测试
$KAFKA_HOME/bin/kafka-consumer-perf-test.sh \
  --topic $TOPIC \
  --bootstrap-server $BOOTSTRAP_SERVERS \
  --messages $NUM_MESSAGES \
  --threads $THREADS \
  --consumer-property group.id=$GROUP_ID \
  --consumer-property auto.offset.reset=earliest \
  --consumer-property fetch.min.bytes=1024 \
  --consumer-property fetch.max.wait.ms=500 \
  --consumer-property max.poll.records=1000

echo "性能测试完成！"
```

---

## 5. 错误处理和重试

### 5.1 常见错误类型

| 错误类型 | 说明 | 处理策略 |
|----------|------|----------|
| **OffsetOutOfRangeException** | Offset 越界 | 重置到 earliest 或 latest |
| **CommitFailedException** | 提交失败 | 检查 `max.poll.interval.ms` |
| **WakeupException** | 调用 wakeup() | 正常关闭，可忽略 |
| **InterruptException** | 线程中断 | 正常关闭，可忽略 |
| **SerializationException** | 反序列化失败 | 检查 Deserializer |
| **TimeoutException** | 超时 | 检查网络，增加超时时间 |

### 5.2 优雅关闭示例

```java
public class GracefulShutdownConsumer {
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "my-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        
        // 注册 shutdown hook
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("正在关闭 Consumer...");
            consumer.wakeup();
        }));
        
        try {
            consumer.subscribe(Collections.singletonList("my-topic"));
            
            while (true) {
                ConsumerRecords<String, String> records = 
                    consumer.poll(Duration.ofMillis(100));
                
                for (ConsumerRecord<String, String> record : records) {
                    processRecord(record);
                }
                
                consumer.commitAsync();
            }
        } catch (WakeupException e) {
            // 忽略，用于优雅关闭
        } finally {
            try {
                consumer.commitSync();
            } finally {
                consumer.close();
                System.out.println("Consumer 已关闭");
            }
        }
    }
    
    private static void processRecord(ConsumerRecord<String, String> record) {
        // 处理逻辑
    }
}
```

---

## 6. 监控和诊断

### 6.1 关键监控指标

| 指标名称 | 说明 | 告警阈值 |
|----------|------|----------|
| `records-consumed-rate` | 每秒消费记录数 | 根据业务期望 |
| `records-lag` | 消费滞后数 | > 1000 |
| `records-lag-max` | 最大滞后数 | > 10000 |
| `fetch-latency-avg` | 平均拉取延迟 | > 500ms |
| `fetch-rate` | 每秒拉取次数 | 异常波动 |
| `commit-latency-avg` | 平均提交延迟 | > 1000ms |
| `assigned-partitions` | 分配的分区数 | 检查 Rebalance |

### 6.2 JMX 监控配置

启用 JMX 监控：

```bash
export JMX_PORT=9998
export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote=true \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false \
  -Djava.rmi.server.hostname=your-host"

# 启动应用
java -jar your-consumer-app.jar
```

### 6.3 日志诊断配置

在 `log4j2.properties` 中添加：

```properties
# Consumer 调试日志
logger.consumer.name = org.apache.kafka.clients.consumer
logger.consumer.level = DEBUG

# 消费组协调日志
logger.coordinator.name = org.apache.kafka.clients.consumer.internals.ConsumerCoordinator
logger.coordinator.level = DEBUG

# 拉取器日志
logger.fetcher.name = org.apache.kafka.clients.consumer.internals.Fetcher
logger.fetcher.level = DEBUG
```

---

## 7. 最佳实践清单

### 7.1 开发最佳实践

- ✅ 始终使用 try-with-resources 管理 Consumer 生命周期
- ✅ 为 Consumer 设置合理的 group.id
- ✅ 根据业务需求选择合适的提交模式
- ✅ 实现优雅关闭逻辑
- ✅ 处理消费异常，避免无限循环

### 7.2 生产部署最佳实践

- ✅ 配置多个 bootstrap.servers 提高可用性
- ✅ 合理设置 `session.timeout.ms` 和 `max.poll.interval.ms`
- ✅ 监控消费滞后并设置告警
- ✅ 根据业务特点调整拉取参数
- ✅ 使用适当数量的消费者实例（不超过分区数）
- ✅ 定期清理或归档消费进度（如需要）

### 7.3 安全最佳实践

- ✅ 使用 SSL/TLS 加密数据传输
- ✅ 使用 SASL 进行身份认证
- ✅ 配置 ACL 限制访问权限
- ✅ 定期轮换凭证和证书
- ✅ 审计敏感操作日志

---

**上一篇**: [09. Producer 生产者详解](../09-producer/README.md)
