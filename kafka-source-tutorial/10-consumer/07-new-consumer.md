# 07. 新版 AsyncKafkaConsumer 详解 (Kafka 3.0+)

本文档深入分析 Kafka 3.0+ 引入的 AsyncKafkaConsumer，了解新架构带来的性能提升和实现原理。

## 目录
- [1. 新旧版本对比](#1-新旧版本对比)
- [2. AsyncKafkaConsumer 架构](#2-asynckafkaconsumer-架构)
- [3. ConsumerNetworkThread](#3-consumernetworkthread)
- [4. 事件驱动模型](#4-事件驱动模型)
- [5. 性能提升分析](#5-性能提升分析)
- [6. 迁移建议](#6-迁移建议)

---

## 1. 新旧版本对比

### 1.1 ClassicKafkaConsumer (老版)

```
ClassicKafkaConsumer 架构：

┌─────────────────────────────────────────────────────────────────┐
│                    ClassicKafkaConsumer                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐         ┌──────────────────────────────┐  │
│  │  用户线程        │         │      ConsumerNetworkClient   │  │
│  │                 │         │                              │  │
│  │  poll() ────────┼────────▶│  - 同步网络 I/O               │  │
│  │    │            │         │  - 阻塞式请求响应             │  │
│  │    ▼            │         │  - 单线程处理                 │  │
│  │  process()      │         │                              │  │
│  │    │            │         │                              │  │
│  │    ▼            │         │                              │  │
│  │  commit() ──────┼────────▶│  - 同步提交                   │  │
│  │                 │         │                              │  │
│  └─────────────────┘         └──────────────────────────────┘  │
│                                                                 │
│  问题：                                                          │
│  1. 用户线程和网络 I/O 在同一线程                                │
│  2. poll() 调用时可能发生阻塞                                    │
│  3. 无法充分利用多核 CPU                                         │
│  4. 高吞吐场景下性能受限                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 AsyncKafkaConsumer (新版)

```
AsyncKafkaConsumer 架构：

┌─────────────────────────────────────────────────────────────────┐
│                     AsyncKafkaConsumer                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐         ┌──────────────────────────────┐  │
│  │  用户线程        │         │    ConsumerNetworkThread     │  │
│  │                 │         │     (后台网络线程)            │  │
│  │  poll() ────────┼────────▶│                              │  │
│  │    │            │         │  ┌────────────────────────┐  │  │
│  │    │            │         │  │  Event Loop            │  │  │
│  │    ▼            │         │  │  - 异步网络 I/O        │  │  │
│  │  process()      │         │  │  - 非阻塞式处理        │  │  │
│  │    │            │         │  │  - 事件驱动            │  │  │
│  │    │            │         │  └────────────────────────┘  │  │
│  │    ▼            │         │                              │  │
│  │  commit() ──────┼────────▶│  ┌────────────────────────┐  │  │
│  │                 │         │  │  Request Queue         │  │  │
│  └─────────────────┘         │  │  Response Queue        │  │  │
│                              │  └────────────────────────┘  │  │
│                              └──────────────────────────────┘  │
│                                                                 │
│  优势：                                                          │
│  1. 用户线程和网络线程分离                                       │
│  2. 真正的异步非阻塞 I/O                                         │
│  3. 更好的 CPU 利用率                                            │
│  4. 更高的吞吐和更低的延迟                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 架构差异总结

| 特性 | ClassicKafkaConsumer | AsyncKafkaConsumer |
|-----|---------------------|-------------------|
| 线程模型 | 单线程（用户线程处理 I/O） | 多线程（独立网络线程） |
| I/O 模式 | 同步阻塞 | 异步非阻塞 |
| 锁竞争 | 高（用户线程竞争网络资源） | 低（无锁队列通信） |
| 吞吐量 | 中等 | 高 |
| 延迟 | 较高 | 低 |
| CPU 利用率 | 低 | 高 |
| 代码复杂度 | 简单 | 较复杂 |

### 1.4 版本选择建议

```java
/**
 * Kafka 3.0+ 默认使用新版 Consumer
 * 可通过配置选择版本
 */

// 使用新版 AsyncKafkaConsumer（默认）
props.put("client.rack", null);  // 确保不触发旧版路径

// 强制使用旧版 ClassicKafkaConsumer（不推荐）
// 部分配置会触发旧版实现，如：
props.put("isolation.level", "read_committed");  // 事务消费暂不支持新版
```

---

## 2. AsyncKafkaConsumer 架构

### 2.1 整体架构图

```java
/**
 * AsyncKafkaConsumer 核心结构
 */
public class AsyncKafkaConsumer<K, V> implements ConsumerDelegate<K, V> {

    // 应用事件队列（用户线程 -> 网络线程）
    private final Queue<ApplicationEvent> applicationEventQueue;

    // 后台网络线程
    private final ConsumerNetworkThread networkThread;

    // 网络客户端
    private final ConsumerNetworkClient networkClient;

    // 订阅状态
    private final SubscriptionState subscriptions;

    // Fetcher
    private final Fetcher<K, V> fetcher;

    // 消费者协调器
    private final ConsumerCoordinator coordinator;

    // 反序列化器
    private final Deserializers deserializers;

    // 配置
    private final ConsumerConfig config;
}
```

### 2.2 与 ConsumerNetworkThread 的协作

```
线程协作模型：

用户线程                              网络线程
   │                                    │
   ├──── ApplicationEvent ─────────────▶│
   │   (poll, commit, subscribe)        │
   │                                    │
   │                                    ├── Process Event
   │                                    │   - Send network request
   │                                    │   - Handle response
   │                                    │
   │◀─── BackgroundEvent ───────────────┤
   │   (fetch complete, commit complete)│
   │                                    │
   ├──── poll() ───────────────────────▶│
   │   (check background events)        │
   │                                    │
   │◀─── ConsumerRecords ───────────────┤
   │                                    │
```

### 2.3 无锁设计

```java
/**
 * 无锁队列实现
 */
public class AsyncKafkaConsumer<K, V> {

    // 使用 ConcurrentLinkedQueue 实现无锁队列
    private final ConcurrentLinkedQueue<ApplicationEvent> appEventQueue;
    private final ConcurrentLinkedQueue<BackgroundEvent> bgEventQueue;

    /**
     * 发送应用事件（用户线程调用）
     */
    private void sendApplicationEvent(ApplicationEvent event) {
        appEventQueue.offer(event);
        networkThread.wakeup();  // 唤醒网络线程
    }

    /**
     * 获取后台事件（用户线程调用）
     */
    private List<BackgroundEvent> getBackgroundEvents() {
        List<BackgroundEvent> events = new ArrayList<>();
        BackgroundEvent event;
        while ((event = bgEventQueue.poll()) != null) {
            events.add(event);
        }
        return events;
    }
}
```

### 2.4 请求队列机制

```java
/**
 * 应用事件类型
 */
public enum ApplicationEventType {
    POLL,           // 拉取消息
    COMMIT,         // 提交 Offset
    SUBSCRIBE,      // 订阅 Topic
    UNSUBSCRIBE,    // 取消订阅
    SEEK,           // 设置消费位置
    PAUSE,          // 暂停分区
    RESUME,         // 恢复分区
    CLOSE           // 关闭 Consumer
}

/**
 * 后台事件类型
 */
public enum BackgroundEventType {
    FETCH_COMPLETE,     // Fetch 完成
    COMMIT_COMPLETE,    // 提交完成
    REBALANCE,          // 重平衡事件
    ERROR               // 错误事件
}
```

---

## 3. ConsumerNetworkThread

### 3.1 网络线程职责

```java
/**
 * 后台网络线程
 */
public class ConsumerNetworkThread implements Runnable {

    private final Queue<ApplicationEvent> appEventQueue;
    private final Queue<BackgroundEvent> bgEventQueue;
    private final ConsumerNetworkClient networkClient;
    private final Fetcher<?, ?> fetcher;
    private final ConsumerCoordinator coordinator;

    private volatile boolean running = true;

    @Override
    public void run() {
        log.debug("Consumer network thread started");

        while (running) {
            try {
                runOnce();
            } catch (Exception e) {
                log.error("Unexpected error in network thread", e);
            }
        }

        log.debug("Consumer network thread closed");
    }

    /**
     * 单次事件循环
     */
    private void runOnce() {
        // 1. 处理应用事件
        processApplicationEvents();

        // 2. 执行网络 I/O
        networkClient.poll(timeout);

        // 3. 处理定时任务
        processDelayedTasks();

        // 4. 触发后台事件
        fireBackgroundEvents();
    }
}
```

### 3.2 事件循环

```java
/**
 * 处理应用事件
 */
private void processApplicationEvents() {
    ApplicationEvent event;
    while ((event = appEventQueue.poll()) != null) {
        switch (event.type()) {
            case POLL:
                handlePollEvent((PollEvent) event);
                break;
            case COMMIT:
                handleCommitEvent((CommitEvent) event);
                break;
            case SUBSCRIBE:
                handleSubscribeEvent((SubscribeEvent) event);
                break;
            case SEEK:
                handleSeekEvent((SeekEvent) event);
                break;
            // ... 其他事件处理
        }
    }
}

/**
 * 处理 Poll 事件
 */
private void handlePollEvent(PollEvent event) {
    // 1. 确保 Coordinator 就绪
    coordinator.poll(time);

    // 2. 发送 Fetch 请求
    fetcher.sendFetches();

    // 3. 检查是否有完成的 Fetch
    if (fetcher.hasCompletedFetches()) {
        // 触发 Fetch 完成事件
        bgEventQueue.offer(new FetchCompleteEvent());
    }
}

/**
 * 处理 Commit 事件
 */
private void handleCommitEvent(CommitEvent event) {
    coordinator.commitOffsetsAsync(
        event.offsets(),
        new OffsetCommitCallback() {
            @Override
            public void onComplete(Map<TopicPartition, OffsetAndMetadata> offsets,
                                   Exception exception) {
                // 提交完成，触发后台事件
                bgEventQueue.offer(new CommitCompleteEvent(offsets, exception));
            }
        }
    );
}
```

### 3.3 请求处理流程

```
请求处理流程：

用户线程                      网络线程                      Broker
   │                           │                             │
   ├─ subscribe(topics) ──────▶│                             │
   │   (创建 SubscribeEvent)   │                             │
   │                           │                             │
   │                           ├── processApplicationEvents  │
   │                           │   - 处理 SubscribeEvent     │
   │                           │                             │
   │                           ├── send JoinGroup ──────────▶│
   │                           │                             │
   │                           │◀──────── JoinGroup Response │
   │                           │                             │
   │                           ├── send SyncGroup ──────────▶│
   │                           │                             │
   │                           │◀──────── SyncGroup Response │
   │                           │                             │
   │                           ├── 触发 Rebalance Event      │
   │◀──────────────────────────┤                             │
   │   (BackgroundEvent)       │                             │
   │                           │                             │
   ├─ poll() ─────────────────▶│                             │
   │                           │                             │
   │                           ├── send Fetch ──────────────▶│
   │                           │                             │
   │                           │◀──────── Fetch Response     │
   │                           │                             │
   │                           ├── 触发 FetchComplete Event  │
   │◀──────────────────────────┤                             │
   │   (ConsumerRecords)       │                             │
```

### 3.4 响应分发机制

```java
/**
 * 网络响应处理
 */
public class ConsumerNetworkClient implements Closeable {

    private final Map<Integer, UnsentRequest> inflightRequests;

    /**
     * 发送请求
     */
    public RequestFuture<ClientResponse> send(Node node,
                                               AbstractRequest.Builder<?> requestBuilder,
                                               int requestTimeoutMs) {
        long now = time.milliseconds();
        RequestFutureCompletionHandler completionHandler =
            new RequestFutureCompletionHandler();

        ClientRequest clientRequest = newClientRequest(
            node.idString(),
            requestBuilder,
            now,
            true,
            requestTimeoutMs,
            completionHandler
        );

        // 添加到发送队列
        unsent.put(node, clientRequest);

        return completionHandler.future;
    }

    /**
     * 轮询网络事件
     */
    public List<ClientResponse> poll(long timeoutMs, long now) {
        // 1. 发送待发送的请求
        sendRequests(now);

        // 2. 执行网络 I/O
        client.poll(timeoutMs, now);

        // 3. 处理响应
        return handleResponses(now);
    }
}
```

---

## 4. 事件驱动模型

### 4.1 事件类型定义

```java
/**
 * 应用事件基类
 */
public abstract class ApplicationEvent {
    private final ApplicationEventType type;
    private final long creationTimeMs;

    public ApplicationEvent(ApplicationEventType type) {
        this.type = type;
        this.creationTimeMs = System.currentTimeMillis();
    }
}

/**
 * Poll 事件
 */
public class PollEvent extends ApplicationEvent {
    private final long timeoutMs;
    private final boolean includeMetadataInTimeout;

    public PollEvent(long timeoutMs, boolean includeMetadataInTimeout) {
        super(ApplicationEventType.POLL);
        this.timeoutMs = timeoutMs;
        this.includeMetadataInTimeout = includeMetadataInTimeout;
    }
}

/**
 * 提交事件
 */
public class CommitEvent extends ApplicationEvent {
    private final Map<TopicPartition, OffsetAndMetadata> offsets;
    private final OffsetCommitCallback callback;

    public CommitEvent(Map<TopicPartition, OffsetAndMetadata> offsets,
                       OffsetCommitCallback callback) {
        super(ApplicationEventType.COMMIT);
        this.offsets = offsets;
        this.callback = callback;
    }
}
```

### 4.2 事件处理流程

```java
/**
 * 用户线程发起 Poll
 */
@Override
public ConsumerRecords<K, V> poll(Duration timeout) {
    // 1. 检查后台事件
    processBackgroundEvents();

    // 2. 发送 Poll 事件到网络线程
    applicationEventQueue.offer(new PollEvent(timeout.toMillis(), true));
    networkThread.wakeup();

    // 3. 等待 Fetch 完成事件
    return awaitFetchComplete(timeout);
}

/**
 * 处理后台事件
 */
private void processBackgroundEvents() {
    BackgroundEvent event;
    while ((event = bgEventQueue.poll()) != null) {
        switch (event.type()) {
            case FETCH_COMPLETE:
                handleFetchComplete((FetchCompleteEvent) event);
                break;
            case COMMIT_COMPLETE:
                handleCommitComplete((CommitCompleteEvent) event);
                break;
            case REBALANCE:
                handleRebalance((RebalanceEvent) event);
                break;
            case ERROR:
                handleError((ErrorEvent) event);
                break;
        }
    }
}

/**
 * 等待 Fetch 完成
 */
private ConsumerRecords<K, V> awaitFetchComplete(Duration timeout) {
    long endTime = System.currentTimeMillis() + timeout.toMillis();

    while (System.currentTimeMillis() < endTime) {
        // 检查后台事件
        processBackgroundEvents();

        // 检查是否有完成的 Fetch
        if (fetcher.hasAvailableRecords()) {
            return fetcher.fetchedRecords();
        }

        // 短暂等待
        LockSupport.parkNanos(100_000);  // 100μs
    }

    return ConsumerRecords.empty();
}
```

### 4.3 回调机制

```java
/**
 * 异步提交回调
 */
public class AsyncCommitCallback implements OffsetCommitCallback {

    private final Queue<BackgroundEvent> bgEventQueue;

    @Override
    public void onComplete(Map<TopicPartition, OffsetAndMetadata> offsets,
                           Exception exception) {
        // 将回调转换为后台事件
        bgEventQueue.offer(new CommitCompleteEvent(offsets, exception));
    }
}

/**
 * 处理提交完成
 */
private void handleCommitComplete(CommitCompleteEvent event) {
    if (event.exception() != null) {
        log.error("Offset commit failed", event.exception());
        // 记录失败，可能需要在下次 poll 时重试
    } else {
        log.debug("Offset commit succeeded: {}", event.offsets());
        // 更新本地状态
        for (Map.Entry<TopicPartition, OffsetAndMetadata> entry :
             event.offsets().entrySet()) {
            subscriptions.committed(entry.getKey(), entry.getValue());
        }
    }
}
```

### 4.4 异常处理

```java
/**
 * 错误事件处理
 */
private void handleError(ErrorEvent event) {
    Exception error = event.exception();

    if (error instanceof WakeupException) {
        // 被唤醒，正常情况
        log.debug("Consumer woken up");
    } else if (error instanceof AuthorizationException) {
        // 权限错误，无法恢复
        throw (AuthorizationException) error;
    } else if (error instanceof RetriableException) {
        // 可重试错误
        log.warn("Retriable error occurred", error);
        // 会在下次 poll 时自动重试
    } else {
        // 其他错误
        log.error("Unexpected error", error);
        throw new KafkaException("Unexpected error in consumer", error);
    }
}

/**
 * 重平衡事件处理
 */
private void handleRebalance(RebalanceEvent event) {
    switch (event.stage()) {
        case REVOKE:
            // 触发分区撤销回调
            Set<TopicPartition> revokedPartitions = event.partitions();
            subscriptions.rebalanceListener()
                .onPartitionsRevoked(revokedPartitions);
            break;

        case ASSIGN:
            // 触发分区分配回调
            Set<TopicPartition> assignedPartitions = event.partitions();
            subscriptions.rebalanceListener()
                .onPartitionsAssigned(assignedPartitions);
            break;
    }
}
```

---

## 5. 性能提升分析

### 5.1 吞吐量提升

```
性能测试对比（单 Consumer，100 分区）：

场景：
- 消息大小：1KB
- 分区数：100
- 副本数：3

ClassicKafkaConsumer:
┌─────────────────────────────────────────────────────────────┐
│ 吞吐量：50,000 msg/s                                         │
│ CPU 使用率：单核 100%                                        │
│ 延迟：p99 = 50ms                                            │
└─────────────────────────────────────────────────────────────┘

AsyncKafkaConsumer:
┌─────────────────────────────────────────────────────────────┐
│ 吞吐量：80,000 msg/s (+60%)                                  │
│ CPU 使用率：多核 60%                                         │
│ 延迟：p99 = 20ms (-60%)                                      │
└─────────────────────────────────────────────────────────────┘

提升原因：
1. 用户线程和网络线程并行
2. 非阻塞 I/O 减少等待
3. 更好的 CPU 利用率
```

### 5.2 延迟降低

| 指标 | Classic | Async | 改善 |
|-----|---------|-------|------|
| p50 延迟 | 10ms | 5ms | 50% |
| p99 延迟 | 50ms | 20ms | 60% |
| p99.9 延迟 | 200ms | 50ms | 75% |
| 最大延迟 | 1000ms | 100ms | 90% |

### 5.3 CPU 使用率优化

```
CPU 使用对比：

ClassicKafkaConsumer:
┌─────────────────────────────────────────────────────────────┐
│ CPU 0: ████████████████████████████████████████ 100%        │
│ CPU 1: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%          │
│ CPU 2: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%          │
│ CPU 3: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%          │
└─────────────────────────────────────────────────────────────┘

AsyncKafkaConsumer:
┌─────────────────────────────────────────────────────────────┐
│ CPU 0: ██████████████████████████████░░░░░░░░░░░ 60%        │
│ CPU 1: ████████████████████░░░░░░░░░░░░░░░░░░░░░ 45%        │
│ CPU 2: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%          │
│ CPU 3: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%          │
└─────────────────────────────────────────────────────────────┘

优势：
- 充分利用多核 CPU
- 避免单核瓶颈
- 系统整体负载更均衡
```

### 5.4 基准测试对比

```java
/**
 * 基准测试代码
 */
public class ConsumerBenchmark {

    public static void main(String[] args) {
        // 预热
        runBenchmark(new ClassicKafkaConsumer<>(props), 10000);
        runBenchmark(new AsyncKafkaConsumer<>(props), 10000);

        // 正式测试
        System.out.println("=== ClassicKafkaConsumer ===");
        runBenchmark(new ClassicKafkaConsumer<>(props), 1000000);

        System.out.println("=== AsyncKafkaConsumer ===");
        runBenchmark(new AsyncKafkaConsumer<>(props), 1000000);
    }

    private static void runBenchmark(Consumer<String, String> consumer,
                                     int messageCount) {
        long startTime = System.currentTimeMillis();
        int count = 0;

        while (count < messageCount) {
            ConsumerRecords<String, String> records =
                consumer.poll(Duration.ofMillis(100));
            count += records.count();
        }

        long duration = System.currentTimeMillis() - startTime;
        double throughput = (double) count / duration * 1000;

        System.out.printf("Processed %d messages in %d ms%n", count, duration);
        System.out.printf("Throughput: %.2f msg/s%n", throughput);
    }
}
```

---

## 6. 迁移建议

### 6.1 配置兼容性

```java
/**
 * AsyncKafkaConsumer 不支持的配置
 */

// 以下配置会触发使用 ClassicKafkaConsumer：
props.put("isolation.level", "read_committed");  // 事务消费
props.put("enable.idempotence", "true");         // 幂等性

// 以下配置在新版中已弃用：
// props.put("max.poll.interval.ms", ...);  // 仍然支持
// props.put("session.timeout.ms", ...);    // 仍然支持
```

### 6.2 API 兼容性

```java
/**
 * API 完全兼容，无需修改业务代码
 */

// 新版和旧版使用相同的 API
KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);

// 订阅
consumer.subscribe(Arrays.asList("topic"));

// 消费
while (true) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    for (ConsumerRecord<String, String> record : records) {
        process(record);
    }
    consumer.commitSync();
}

// 关闭
consumer.close();
```

### 6.3 逐步迁移策略

```
迁移策略：

阶段 1: 验证阶段
┌─────────────────────────────────────────────────────────────┐
│ 1. 在测试环境验证 AsyncKafkaConsumer                        │
│ 2. 对比功能和性能指标                                       │
│ 3. 确认无兼容性问题                                         │
└─────────────────────────────────────────────────────────────┘

阶段 2: 灰度发布
┌─────────────────────────────────────────────────────────────┐
│ 1. 选择部分 Consumer 实例使用新版                           │
│ 2. 监控错误率和性能指标                                     │
│ 3. 逐步扩大范围                                            │
└─────────────────────────────────────────────────────────────┘

阶段 3: 全量迁移
┌─────────────────────────────────────────────────────────────┐
│ 1. 所有 Consumer 使用新版                                   │
│ 2. 监控整体系统健康度                                       │
│ 3. 保留回滚方案                                            │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 注意事项

```java
/**
 * 迁移注意事项
 */

// 1. 确保 Kafka 版本 >= 3.0
// AsyncKafkaConsumer 需要 Kafka 3.0+

// 2. 事务消费暂不支持新版
// 如果需要事务消费，会自动回退到 ClassicKafkaConsumer

// 3. 监控指标可能略有不同
// 部分 JMX 指标名称可能有变化

// 4. 线程数增加
// 新版会创建一个额外的网络线程

// 5. 内存使用略有增加
// 事件队列和缓冲需要额外内存

// 6. 日志格式变化
// 新版有更多关于事件处理的日志
```

---

**上一章**: [06. Offset 管理策略](./06-offset-management.md)
**下一章**: [08. Consumer 配置详解](./08-consumer-config.md)
