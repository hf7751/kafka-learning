# 06. Producer 拦截器

本文档介绍 Kafka Producer 的拦截器机制，了解如何在消息发送前后进行自定义处理。

## 目录
- [1. 拦截器概述](#1-拦截器概述)
- [2. ProducerInterceptor 接口](#2-producerinterceptor-接口)
- [3. 拦截器链](#3-拦截器链)
- [4. 实战案例](#4-实战案例)
- [5. 性能考虑](#5-性能考虑)

---

## 1. 拦截器概述

### 1.1 拦截器的作用

Producer 拦截器允许在消息发送前后执行自定义逻辑，常见用途：

| 用途 | 说明 |
|-----|------|
| **日志记录** | 记录消息发送情况，用于审计和监控 |
| **消息增强** | 添加统一字段（如 traceId、时间戳） |
| **数据脱敏** | 敏感字段加密或脱敏处理 |
| **合规检查** | 验证消息格式和内容合规性 |
| **指标收集** | 统计发送延迟、成功率等指标 |

### 1.2 拦截点位置

```
消息发送生命周期：

┌─────────────────────────────────────────────────────────────┐
│                     KafkaProducer.send()                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 拦截器 onSend() ───────────────────────────────┐        │
│     │  消息发送前拦截                                │        │
│     │  可修改消息内容                                │        │
│     ▼                                              │        │
│  2. 序列化                                          │        │
│     key/value 序列化为字节数组                        │        │
│     │                                              │        │
│     ▼                                              │        │
│  3. 分区计算                                        │        │
│     partitioner.partition()                        │        │
│     │                                              │        │
│     ▼                                              │        │
│  4. 写入 RecordAccumulator                          │        │
│     消息进入缓冲区                                   │        │
│     │                                              │        │
│     ▼                                              │        │
│  5. Sender 线程发送                                 │        │
│     消息发送到 Broker                               │        │
│     │                                              │        │
│     ▼                                              │        │
│  6. 接收响应                                        │        │
│     收到 ProduceResponse                           │        │
│     │                                              │        │
│     ▼                                              │        │
│  7. 拦截器 onAcknowledgement() ◀───────────────────┘        │
│     消息响应后拦截                                   │        │
│     记录发送结果                                    │        │
│     │                                              │        │
│     ▼                                              │        │
│  8. 触发 Callback                                   │        │
│     用户回调函数执行                                │        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 与 AOP 的对比

| 特性 | Producer 拦截器 | AOP（Spring） |
|-----|----------------|--------------|
| **作用域** | 仅限于 Kafka Producer | 任意方法调用 |
| **时机** | 发送前/响应后 | 任意切面点 |
| **能力** | 可修改消息内容 | 可修改参数/返回值 |
| **性能** | 直接嵌入发送流程 | 需要代理开销 |
| **依赖** | 无外部依赖 | 需要 Spring 框架 |

---

## 2. ProducerInterceptor 接口

### 2.1 接口定义

```java
/**
 * Producer 拦截器接口
 * 允许在消息发送前后进行自定义处理
 */
public interface ProducerInterceptor<K, V> extends Configurable {

    /**
     * 在消息发送前调用
     *
     * 此方法在消息被序列化和分配到分区之前调用。
     * 可以修改消息内容，也可以返回新的 ProducerRecord。
     *
     * @param record 原始消息记录
     * @return 处理后的消息记录（可以是修改后的或全新的）
     */
    ProducerRecord<K, V> onSend(ProducerRecord<K, V> record);

    /**
     * 在收到 Broker 响应后调用
     *
     * 此方法在确认消息被 Broker 接收后调用，或在发送失败时调用。
     * 在用户的 Callback 被调用之前执行。
     *
     * @param metadata 消息的元数据（成功时包含 offset、partition）
     * @param exception 发送异常（成功时为 null）
     */
    void onAcknowledgement(RecordMetadata metadata, Exception exception);

    /**
     * 关闭拦截器
     *
     * 在 KafkaProducer 关闭时调用，用于释放资源。
     */
    void close();
}
```

### 2.2 onSend() - 发送前拦截

```java
/**
 * 发送前拦截示例：添加追踪 ID
 */
public class TracingInterceptor implements ProducerInterceptor<String, String> {

    private static final String TRACE_ID_KEY = "trace-id";

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // 生成追踪 ID
        String traceId = UUID.randomUUID().toString();

        // 添加到消息头
        List<Header> headers = new ArrayList<>(record.headers());
        headers.add(new RecordHeader(TRACE_ID_KEY, traceId.getBytes(StandardCharsets.UTF_8)));

        // 返回新的 ProducerRecord（包含追踪 ID）
        return new ProducerRecord<>(
            record.topic(),
            record.partition(),
            record.timestamp(),
            record.key(),
            record.value(),
            headers
        );
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        // 发送后处理
    }

    @Override
    public void close() {
    }

    @Override
    public void configure(Map<String, ?> configs) {
    }
}
```

**注意事项**：
- `onSend()` 在序列化之前调用，因此可以修改 key/value
- 返回 null 会导致消息不被发送（慎用）
- 不要执行耗时操作，会阻塞发送线程

### 2.3 onAcknowledgement() - 响应后拦截

```java
/**
 * 响应后拦截示例：记录指标
 */
public class MetricsInterceptor implements ProducerInterceptor<String, String> {

    private final Counter successCounter;
    private final Counter failureCounter;
    private final Histogram latencyHistogram;

    public MetricsInterceptor() {
        // 初始化指标收集器
        this.successCounter = Metrics.counter("kafka.producer.success");
        this.failureCounter = Metrics.counter("kafka.producer.failure");
        this.latencyHistogram = Metrics.histogram("kafka.producer.latency");
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // 记录发送开始时间
        record.headers().add("send-time",
            String.valueOf(System.currentTimeMillis()).getBytes());
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        if (exception == null) {
            // 发送成功
            successCounter.increment();

            // 计算延迟
            long sendTime = extractSendTime(metadata);
            long latency = System.currentTimeMillis() - sendTime;
            latencyHistogram.record(latency);
        } else {
            // 发送失败
            failureCounter.increment();

            // 记录错误类型
            Metrics.counter("kafka.producer.error",
                "type", exception.getClass().getSimpleName()).increment();
        }
    }

    @Override
    public void close() {
        // 清理指标收集器
    }

    @Override
    public void configure(Map<String, ?> configs) {
    }
}
```

**执行时机**：

```
响应处理流程：

1. Sender 线程接收响应
         │
         ▼
2. 处理响应状态
         │
         ▼
3. 调用拦截器 onAcknowledgement()
   (多个拦截器按顺序调用)
         │
         ▼
4. 调用用户 Callback
         │
         ▼
5. 完成 Future
```

### 2.4 close() - 关闭资源

```java
/**
 * 关闭时释放资源
 */
public class ResourceCleanupInterceptor implements ProducerInterceptor<String, String> {

    private ExecutorService executorService;
    private Connection connection;

    @Override
    public void configure(Map<String, ?> configs) {
        // 初始化资源
        this.executorService = Executors.newFixedThreadPool(2);
        this.connection = createConnection(configs);
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // 使用资源...
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        // 使用资源...
    }

    @Override
    public void close() {
        // 关闭时释放资源
        if (executorService != null) {
            executorService.shutdown();
            try {
                if (!executorService.awaitTermination(60, TimeUnit.SECONDS)) {
                    executorService.shutdownNow();
                }
            } catch (InterruptedException e) {
                executorService.shutdownNow();
            }
        }

        if (connection != null) {
            try {
                connection.close();
            } catch (SQLException e) {
                log.error("Error closing connection", e);
            }
        }
    }
}
```

---

## 3. 拦截器链

### 3.1 多个拦截器的执行顺序

```java
// 配置多个拦截器
props.put("interceptor.classes",
    "com.example.TracingInterceptor,com.example.MetricsInterceptor,com.example.AuditInterceptor");
```

```
拦截器链执行顺序：

onSend() 执行顺序（正向）：
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ 原始消息 │──▶│拦截器 1 │──▶│拦截器 2 │──▶│拦截器 3 │──▶ 发送
└─────────┘   └─────────┘   └─────────┘   └─────────┘

onAcknowledgement() 执行顺序（反向）：
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ 响应结果 │──▶│拦截器 3 │──▶│拦截器 2 │──▶│拦截器 1 │──▶ 回调
└─────────┘   └─────────┘   └─────────┘   └─────────┘
```

### 3.2 异常处理机制

```java
/**
 * 拦截器链异常处理
 */
public class ProducerInterceptors<K, V> {

    private final List<ProducerInterceptor<K, V>> interceptors;

    public ProducerRecord<K, V> onSend(ProducerRecord<K, V> record) {
        ProducerRecord<K, V> interceptRecord = record;

        for (ProducerInterceptor<K, V> interceptor : interceptors) {
            try {
                interceptRecord = interceptor.onSend(interceptRecord);
            } catch (Exception e) {
                // 拦截器异常不会中断发送，但会记录错误
                if (interceptRecord != null) {
                    log.warn("Error executing interceptor onSend callback", e);
                } else {
                    log.error("Error executing interceptor onSend callback", e);
                    // 如果返回 null，后续拦截器仍会继续执行
                    // 但实际消息不会发送
                }
            }
        }

        return interceptRecord;
    }

    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        for (ProducerInterceptor<K, V> interceptor : interceptors) {
            try {
                interceptor.onAcknowledgement(metadata, exception);
            } catch (Exception e) {
                // 拦截器异常不会中断确认流程
                log.error("Error executing interceptor onAcknowledgement callback", e);
            }
        }
    }
}
```

### 3.3 拦截器上下文传递

```java
/**
 * 使用消息头在拦截器间传递上下文
 */
public class ContextInterceptor implements ProducerInterceptor<String, String> {

    // ThreadLocal 存储上下文
    private static final ThreadLocal<Map<String, Object>> contextHolder =
        new ThreadLocal<>();

    // 设置上下文（业务代码调用）
    public static void setContext(String key, Object value) {
        Map<String, Object> context = contextHolder.get();
        if (context == null) {
            context = new HashMap<>();
            contextHolder.set(context);
        }
        context.put(key, value);
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        Map<String, Object> context = contextHolder.get();
        if (context != null) {
            Headers headers = record.headers();

            // 将上下文写入消息头
            context.forEach((key, value) -> {
                headers.add(
                    "ctx-" + key,
                    value.toString().getBytes(StandardCharsets.UTF_8)
                );
            });

            // 清理 ThreadLocal
            contextHolder.remove();
        }

        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
    }

    @Override
    public void close() {
    }

    @Override
    public void configure(Map<String, ?> configs) {
    }
}

// 业务代码使用
ContextInterceptor.setContext("userId", userId);
ContextInterceptor.setContext("requestId", requestId);
producer.send(record);
```

---

## 4. 实战案例

### 4.1 日志记录拦截器

```java
/**
 * 记录消息发送日志
 */
public class LoggingInterceptor implements ProducerInterceptor<String, String> {

    private static final Logger log = LoggerFactory.getLogger(LoggingInterceptor.class);
    private String clientId;

    @Override
    public void configure(Map<String, ?> configs) {
        this.clientId = (String) configs.get("client.id");
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        if (log.isDebugEnabled()) {
            log.debug("[{}] Sending message to topic={}, partition={}, key={}",
                clientId,
                record.topic(),
                record.partition(),
                record.key());
        }
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        if (exception != null) {
            log.error("[{}] Failed to send message to topic={}, partition={}",
                clientId,
                metadata != null ? metadata.topic() : "unknown",
                metadata != null ? metadata.partition() : "unknown",
                exception);
        } else if (log.isDebugEnabled()) {
            log.debug("[{}] Message sent successfully to topic={}, partition={}, offset={}",
                clientId,
                metadata.topic(),
                metadata.partition(),
                metadata.offset());
        }
    }

    @Override
    public void close() {
    }
}
```

### 4.2 消息审计拦截器

```java
/**
 * 消息审计 - 记录所有发送的消息到审计系统
 */
public class AuditInterceptor implements ProducerInterceptor<String, String> {

    private AuditService auditService;
    private String producerId;

    @Override
    public void configure(Map<String, ?> configs) {
        this.producerId = (String) configs.get("client.id");
        this.auditService = new AuditService(configs);
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // 记录发送前审计日志
        AuditEvent event = AuditEvent.builder()
            .eventType("KAFKA_SEND")
            .producerId(producerId)
            .topic(record.topic())
            .partition(record.partition())
            .key(record.key())
            .timestamp(System.currentTimeMillis())
            .messageSize(sizeOf(record))
            .build();

        auditService.log(event);

        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        AuditEvent event = AuditEvent.builder()
            .eventType(exception == null ? "KAFKA_ACK" : "KAFKA_ERROR")
            .producerId(producerId)
            .topic(metadata.topic())
            .partition(metadata.partition())
            .offset(metadata.offset())
            .timestamp(System.currentTimeMillis())
            .error(exception != null ? exception.getMessage() : null)
            .build();

        auditService.log(event);
    }

    @Override
    public void close() {
        auditService.close();
    }

    private int sizeOf(ProducerRecord<?, ?> record) {
        int size = 0;
        if (record.key() != null) {
            size += record.key().toString().getBytes().length;
        }
        if (record.value() != null) {
            size += record.value().toString().getBytes().length;
        }
        return size;
    }
}
```

### 4.3 数据脱敏拦截器

```java
/**
 * 敏感数据脱敏拦截器
 */
public class DesensitizationInterceptor implements ProducerInterceptor<String, String> {

    // 敏感字段配置
    private Set<String> sensitiveFields;
    private DesensitizationStrategy strategy;

    @Override
    public void configure(Map<String, ?> configs) {
        String fields = (String) configs.get("sensitive.fields");
        this.sensitiveFields = new HashSet<>(Arrays.asList(fields.split(",")));

        String strategyName = (String) configs.get("sensitive.strategy");
        this.strategy = DesensitizationStrategy.valueOf(strategyName);
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        String value = record.value();
        if (value == null) {
            return record;
        }

        // 假设 value 是 JSON 格式
        try {
            JsonNode jsonNode = objectMapper.readTree(value);
            ObjectNode objectNode = (ObjectNode) jsonNode;

            for (String field : sensitiveFields) {
                if (objectNode.has(field)) {
                    String originalValue = objectNode.get(field).asText();
                    String desensitizedValue = desensitize(originalValue);
                    objectNode.put(field, desensitizedValue);
                }
            }

            String newValue = objectMapper.writeValueAsString(objectNode);

            return new ProducerRecord<>(
                record.topic(),
                record.partition(),
                record.timestamp(),
                record.key(),
                newValue,
                record.headers()
            );

        } catch (Exception e) {
            log.error("Failed to desensitize message", e);
            return record;  // 脱敏失败，原样返回
        }
    }

    private String desensitize(String value) {
        switch (strategy) {
            case MASK:
                // 全遮掩：********
                return "*".repeat(value.length());
            case PARTIAL:
                // 部分遮掩：138****8888
                if (value.length() > 7) {
                    return value.substring(0, 3) + "****" +
                           value.substring(value.length() - 4);
                }
                return "****";
            case HASH:
                // 哈希处理
                return DigestUtils.md5Hex(value);
            default:
                return value;
        }
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
    }

    @Override
    public void close() {
    }

    enum DesensitizationStrategy {
        MASK,      // 完全遮掩
        PARTIAL,   // 部分遮掩
        HASH       // 哈希处理
    }
}

// 配置使用
props.put("interceptor.classes", "com.example.DesensitizationInterceptor");
props.put("sensitive.fields", "phone,idCard,bankCard");
props.put("sensitive.strategy", "PARTIAL");
```

### 4.4 监控指标收集拦截器

```java
/**
 * Prometheus 指标收集拦截器
 */
public class PrometheusInterceptor implements ProducerInterceptor<String, String> {

    private static final Counter sendCounter = Counter.build()
        .name("kafka_producer_send_total")
        .help("Total messages sent")
        .labelNames("topic", "partition")
        .register();

    private static final Counter ackCounter = Counter.build()
        .name("kafka_producer_ack_total")
        .help("Total acknowledgments received")
        .labelNames("topic", "status")
        .register();

    private static final Histogram latencyHistogram = Histogram.build()
        .name("kafka_producer_latency_seconds")
        .help("Send latency in seconds")
        .labelNames("topic")
        .buckets(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0)
        .register();

    private final ThreadLocal<Long> sendTime = new ThreadLocal<>();

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        sendTime.set(System.nanoTime());

        sendCounter.labels(
            record.topic(),
            String.valueOf(record.partition())
        ).inc();

        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        Long startTime = sendTime.get();
        if (startTime != null) {
            double latency = (System.nanoTime() - startTime) / 1_000_000_000.0;
            latencyHistogram.labels(metadata.topic()).observe(latency);
            sendTime.remove();
        }

        if (exception == null) {
            ackCounter.labels(metadata.topic(), "success").inc();
        } else {
            ackCounter.labels(metadata.topic(), "failure").inc();
        }
    }

    @Override
    public void close() {
    }

    @Override
    public void configure(Map<String, ?> configs) {
    }
}
```

---

## 5. 性能考虑

### 5.1 拦截器对吞吐量的影响

```
基准测试结果（10万条消息）：

无拦截器：
- 吞吐量：50,000 msg/s
- 延迟：p99 = 5ms

单个轻量级拦截器（onSend 只做计数）：
- 吞吐量：48,000 msg/s (-4%)
- 延迟：p99 = 5.2ms

单个重量级拦截器（onSend 做 JSON 解析）：
- 吞吐量：30,000 msg/s (-40%)
- 延迟：p99 = 12ms

多个拦截器（5 个）：
- 吞吐量：35,000 msg/s (-30%)
- 延迟：p99 = 10ms
```

### 5.2 异步处理建议

```java
/**
 * 异步执行拦截器逻辑
 */
public class AsyncInterceptor implements ProducerInterceptor<String, String> {

    private ExecutorService executor;

    @Override
    public void configure(Map<String, ?> configs) {
        // 使用独立线程池处理异步任务
        this.executor = Executors.newFixedThreadPool(2);
    }

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        // onSend 必须同步执行，但可以将耗时操作转为异步

        // 同步：添加轻量级标记
        record.headers().add("intercepted", "true".getBytes());

        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        // onAcknowledgement 可以异步处理
        executor.submit(() -> {
            // 耗时操作：写入日志、发送指标等
            writeToLog(metadata);
            sendMetrics(metadata, exception);
        });
    }

    @Override
    public void close() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(60, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
        }
    }
}
```

### 5.3 异常处理最佳实践

```java
/**
 * 健壮性良好的拦截器
 */
public class RobustInterceptor implements ProducerInterceptor<String, String> {

    @Override
    public ProducerRecord<String, String> onSend(ProducerRecord<String, String> record) {
        try {
            // 业务逻辑
            return doIntercept(record);
        } catch (Exception e) {
            // 1. 记录错误
            log.error("Interceptor error, passing through original record", e);

            // 2. 返回原始消息（不要阻断发送）
            return record;
        }
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        try {
            // 业务逻辑
            doAck(metadata, exception);
        } catch (Exception e) {
            // onAcknowledgement 异常不应影响业务流程
            log.error("Acknowledgement processing error", e);
        }
    }

    private ProducerRecord<String, String> doIntercept(ProducerRecord<String, String> record) {
        // 拦截器业务逻辑
        return record;
    }

    private void doAck(RecordMetadata metadata, Exception exception) {
        // 确认处理逻辑
    }

    @Override
    public void close() {
    }

    @Override
    public void configure(Map<String, ?> configs) {
    }
}
```

**最佳实践总结**：

| 原则 | 说明 |
|-----|------|
| **快速执行** | onSend() 应尽可能快，避免阻塞发送线程 |
| **容错处理** | 拦截器异常不应导致消息发送失败 |
| **资源管理** | 在 close() 中正确释放资源 |
| **线程安全** | 拦截器可能被多线程调用，注意线程安全 |
| **监控报警** | 对拦截器执行时间进行监控 |

---

**上一章**: [05. 分区器详解](./05-partitioner.md)
**下一章**: [07. TransactionManager 事务管理器](./07-transaction-manager.md)
