# 06. NetworkClient 网络客户端实现

NetworkClient 是 Kafka 客户端的核心网络通信组件，负责管理连接、发送请求、处理响应。本文深入分析其内部实现机制。

## 目录
- [1. NetworkClient 概述](#1-networkclient-概述)
- [2. 连接管理](#2-连接管理)
- [3. 请求发送流程](#3-请求发送流程)
- [4. 响应处理流程](#4-响应处理流程)
- [5. 请求队列管理](#5-请求队列管理)
- [6. 超时与重试](#6-超时与重试)

---

## 1. NetworkClient 概述

### 1.1 NetworkClient 的职责

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Kafka Client                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Producer   │  │   Consumer   │  │    Admin     │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                     │
│         └──────────────────┼──────────────────┘                     │
│                            ▼                                        │
│              ┌─────────────────────────────┐                        │
│              │       NetworkClient         │                        │
│              │                             │                        │
│              │  1. 连接管理 (建立/断开/复用) │                       │
│              │  2. 请求发送 (序列化/发送)    │                       │
│              │  3. 响应处理 (读取/反序列化)  │                       │
│              │  4. 超时处理 (重试/回调)      │                       │
│              └──────────────┬──────────────┘                        │
│                             ▼                                       │
│              ┌─────────────────────────────┐                        │
│              │      Selector (NIO)         │                        │
│              │                             │                        │
│              │  - 多路复用                  │                       │
│              │  - 非阻塞 I/O               │                        │
│              └──────────────┬──────────────┘                        │
│                             ▼                                       │
│              ┌─────────────────────────────┐                        │
│              │       TCP Socket            │                        │
│              └─────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 与 Selector 的关系

**源码位置**: `clients/src/main/java/org/apache/kafka/clients/NetworkClient.java`

```java
public class NetworkClient implements KafkaClient {

    // 选择器，负责底层的 NIO 操作
    private final Selectable selector;

    // 元数据管理
    private final Metadata metadata;

    // 连接状态管理
    private final ClusterConnectionStates connectionStates;

    // 在途请求管理
    private final InFlightRequests inFlightRequests;

    // 节点 API 版本信息
    private final Map<Integer, NodeApiVersions> nodeApiVersions;

    // 网络 client ID
    private final String clientId;

    // 请求超时时间
    private final int requestTimeoutMs;

    // Socket 发送缓冲区
    private final int socketSendBuffer;

    // Socket 接收缓冲区
    private final int socketReceiveBuffer;

    // 发现 broker 的间隔
    private final long metadataBackoffMs;

    // 其他配置...
}
```

### 1.3 核心字段分析

| 字段 | 类型 | 说明 |
|------|------|------|
| `selector` | Selectable | 底层 NIO 选择器 |
| `metadata` | Metadata | 集群元数据 |
| `connectionStates` | ClusterConnectionStates | 连接状态管理 |
| `inFlightRequests` | InFlightRequests | 在途请求队列 |
| `nodeApiVersions` | Map<Integer, NodeApiVersions> | 节点 API 版本缓存 |

---

## 2. 连接管理

### 2.1 连接建立流程

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   调用 send  │────→│ 检查连接状态 │────→│ 建立新连接   │────→│ 等待连接完成 │
│   请求发送   │     │              │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                                                    │                  │
                                                    ▼                  ▼
                                           ┌──────────────┐     ┌──────────────┐
                                           │   连接已存在  │     │ 发送 ApiVers │
                                           │   直接发送    │     │ ions 请求    │
                                           └──────────────┘     └──────────────┘
                                                                         │
                                                                         ▼
                                                                ┌──────────────┐
                                                                │ 版本协商完成 │
                                                                │ 标记为 ready │
                                                                └──────────────┘
```

```java
// 准备发送请求到指定节点
public boolean ready(Node node, long now) {
    if (node.isEmpty())
        throw new IllegalArgumentException("Cannot connect to empty node");

    // 检查是否已准备好（连接已建立且版本协商完成）
    if (isReady(node, now))
        return true;

    // 发起连接
    if (connectionStates.canConnect(node.idString(), now))
            initiateConnect(node, now);

    return false;
}

// 检查节点是否就绪
public boolean isReady(Node node, long now) {
    return !metadataUpdater.isUpdateDue(now)
        && connectionStates.isReady(node.idString(), now)
        && inFlightRequests.canSendMore(node.idString());
}

// 发起连接
private void initiateConnect(Node node, long now) {
    String nodeId = node.idString();
    try {
        log.debug("Initiating connection to node {} at {}:{}" ,
                nodeId, node.host(), node.port());

        // 更新连接状态为 CONNECTING
        connectionStates.connecting(nodeId, now, node.host());

        // 获取 broker 地址
        InetAddress address = connectionStates.currentAddress(nodeId);

        // 通过 selector 建立连接
        selector.connect(nodeId,
            new InetSocketAddress(address, node.port()),
            this.socketSendBuffer,
            this.socketReceiveBuffer);
    } catch (IOException e) {
        // 连接失败处理
        connectionStates.disconnected(nodeId, now);
        maybeThrowAuthFailure(node);

        // 记录失败，稍后重试
        log.warn("Error connecting to node {}", nodeId, e);
    }
}
```

### 2.2 连接状态机

**源码位置**: `clients/src/main/java/org/apache/kafka/clients/ClusterConnectionStates.java`

```
┌─────────────┐
│  DISCONNECTED │◄─────────────────────────────┐
└──────┬──────┘                                │
       │ 发起连接                               │
       ▼                                        │
┌─────────────┐     连接超时/失败                │
│  CONNECTING  │───────────────────────────────┤
└──────┬──────┘                                │
       │ 连接成功                               │
       ▼                                        │
┌─────────────┐     SSL 握手完成                │
│   CHECKING_API_VERSIONS                     │
│              │───────────────────────────────┤
└──────┬──────┘                                │
       │ ApiVersions 请求成功                   │
       ▼                                        │
┌─────────────┐     连接断开/空闲超时            │
│     READY    │───────────────────────────────┘
└─────────────┘
```

```java
public enum ConnectionState {
    DISCONNECTED,      // 断开连接
    CONNECTING,        // 正在连接
    CHECKING_API_VERSIONS,  // 检查 API 版本
    READY              // 就绪，可以发送请求
}

public class ClusterConnectionStates {

    // 节点连接状态映射
    private final Map<String, NodeConnectionState> nodeState;

    // 节点连接状态
    private static class NodeConnectionState {
        ConnectionState state;
        long lastConnectAttemptMs;  // 上次尝试连接时间
        long lastSuccessfulConnectMs;  // 上次成功连接时间
        int failedAttempts;  // 连续失败次数
        String host;  // 目标主机
        // ...
    }

    // 检查是否可以发起连接
    public boolean canConnect(String id, long now) {
        NodeConnectionState state = nodeState.get(id);
        if (state == null)
            return true;

        return state.state == ConnectionState.DISCONNECTED &&
               now - state.lastConnectAttemptMs >= reconnectBackoffMs(state.failedAttempts);
    }

    // 计算退避时间（指数退避）
    private long reconnectBackoffMs(int failedAttempts) {
        if (failedAttempts == 0)
            return reconnectBackoffMs;

        // 指数退避，但有上限
        return Math.min(reconnectBackoffMs * (1L << Math.min(failedAttempts - 1, 15)),
                        reconnectBackoffMaxMs);
    }
}
```

### 2.3 连接复用策略

```java
// 保持长连接，复用现有连接
public class NetworkClient {

    // 默认连接空闲超时时间（9 分钟，小于 broker 的 10 分钟）
    private static final int DEFAULT_CONNECTION_MAX_IDLE_MS = 9 * 60 * 1000;

    // 检查空闲连接
    public void closeIdleConnections(long now) {
        // 关闭超过空闲时间的连接
        long idleTimeout = defaultConnectionMaxIdleMs;
        selector.closeIdleConnections(idleTimeout, connectionsClosed -> {
            for (String connectionId : connectionsClosed) {
                // 清理相关状态
                connectionStates.disconnected(connectionId, now);
                inFlightRequests.clearAll(connectionId);
            }
        });
    }
}
```

### 2.4 连接断开处理

```java
// 处理连接断开
private void processDisconnection(List<ClientResponse> responses, String nodeId, long now) {
    // 更新连接状态
    connectionStates.disconnected(nodeId, now);

    // 获取该连接的所有在途请求
    List<InFlightRequest> inFlightRequests = this.inFlightRequests.clearAll(nodeId);

    for (InFlightRequest request : inFlightRequests) {
        // 创建断开连接响应
        ClientResponse clientResponse = new ClientResponse(
            request.makeHeader(),
            request.callback(),
            nodeId,
            now,
            now,
            false,
            null,
            null
        );
        responses.add(clientResponse);
    }

    // 如果断开的是元数据节点，需要更新元数据
    if (metadataUpdater.isUpdateDue(now))
        metadataUpdater.requestUpdate();
}
```

---

## 3. 请求发送流程

### 3.1 doSend() 方法分析

```java
// 发送请求的核心方法
private void doSend(ClientRequest clientRequest, boolean isInternalRequest, long now) {
    String nodeId = clientRequest.destination();

    // 1. 检查连接是否就绪
    if (!isReady(nodeId, now)) {
        // 如果连接未就绪，放入待发送队列
        clientRequest.requestTimeoutMs();
        return;
    }

    // 2. 构建请求头
    AbstractRequest.Builder<?> builder = clientRequest.requestBuilder();
    short version = nodeApiVersions.latestUsableVersion(
        clientRequest.apiKey(), builder.oldestAllowedVersion(),
        builder.latestAllowedVersion()
    );

    // 3. 序列化请求
    AbstractRequest request = builder.build(version);
    Send send = request.toSend(nodeId, requestHeader);

    // 4. 放入在途请求队列
    InFlightRequest inFlightRequest = new InFlightRequest(
        clientRequest,
        requestHeader,
        isInternalRequest,
        send,
        now
    );
    this.inFlightRequests.add(inFlightRequest);

    // 5. 通过 selector 发送
    selector.send(send);
}
```

### 3.2 请求序列化

```java
// 请求转换为 Send 对象
public Send toSend(String destination, RequestHeader header) {
    return new NetworkSend(destination, serialize(header));
}

// 序列化为 ByteBuffer
private ByteBuffer serialize(RequestHeader header) {
    // 计算请求大小
    int size = header.sizeOf() + sizeOf();

    // 分配 buffer
    ByteBuffer buffer = ByteBuffer.allocate(size + 4);  // 4 字节长度前缀

    // 写入长度
    buffer.putInt(size);

    // 写入请求头
    header.writeTo(buffer);

    // 写入请求体
    writeTo(buffer);

    buffer.rewind();
    return buffer;
}
```

### 3.3 网络写入

```java
// Selector 发送数据
public class Selector implements Selectable {

    public void send(Send send) {
        String connectionId = send.destination();
        KafkaChannel channel = openOrClosingChannelOrFail(connectionId);

        try {
            channel.setSend(send);
        } catch (CancelledKeyException e) {
            // 连接已关闭
            close(connectionId, false);
        }
    }
}

// KafkaChannel 设置发送数据
public class KafkaChannel {

    private Send send;  // 当前待发送的数据

    public void setSend(Send send) {
        if (this.send != null)
            throw new IllegalStateException("Attempt to begin a send operation with prior send operation still in progress");

        this.send = send;
        this.transportLayer.addInterestOps(SelectionKey.OP_WRITE);
    }
}
```

### 3.4 发送完成回调

```java
// 请求发送完成后的处理
private void completeSend(Send send, long now) {
    // 释放发送缓冲区
    send.completed();

    // 触发发送完成回调
    if (send.callback() != null)
        send.callback().onComplete(send);
}
```

---

## 4. 响应处理流程

### 4.1 poll() 方法分析

```java
// NetworkClient 核心方法
public List<ClientResponse> poll(long timeout, long now) {
    // 1. 更新元数据
    long metadataTimeout = metadataUpdater.maybeUpdate(now);

    // 2. 调用底层 selector 进行网络 I/O
    long pollTimeout = Math.min(timeout, metadataTimeout);
    List<ClientResponse> responses = poll(pollTimeout, now);

    return responses;
}

// 处理网络 I/O 和响应
private List<ClientResponse> poll(long timeout, long now) {
    // 1. 处理已完成的响应
    List<ClientResponse> responses = new ArrayList<>();
    processCompletedSends(responses, now);
    processCompletedReceives(responses, now);

    // 2. 处理断开的连接
    processDisconnected(responses, now);

    // 3. 处理超时请求
    processTimedOutRequests(responses, now);

    // 4. 检查连接是否就绪（SSL 握手、ApiVersions 完成）
    checkReady(responses, now);

    // 5. 调用底层 selector
    long pollDelayMs = Math.min(timeout, metadataBackoffMs);
    this.selector.poll(pollDelayMs);

    return responses;
}
```

### 4.2 网络读取

```java
// Selector 处理接收到的数据
private void pollSelectionKeys(Set<SelectionKey> selectionKeys,
                                boolean isImmediatelyConnected,
                                long currentTimeNanos) {
    for (SelectionKey key : selectionKeys) {
        KafkaChannel channel = channel(key);

        // 读取数据
        if (channel.ready() && (key.isReadable() || channel.hasBytesBuffered())) {
            attemptRead(channel);
        }

        // 写入数据
        if (channel.ready() && key.isWritable()) {
            Send send = channel.write();
            if (send != null) {
                this.completedSends.add(send);
                this.sensors.recordBytesSent(channel.id(), send.size());
            }
        }
    }
}

// 尝试读取数据
private void attemptRead(KafkaChannel channel) {
    String nodeId = channel.id();

    // 获取或创建接收缓冲区
    NetworkReceive receive = channel.receive();

    if (receive != null) {
        // 完整的数据包已接收
        addToCompletedReceives(channel, receive, now);
    }
}
```

### 4.3 响应解析

```java
// 处理接收到的响应
private void processCompletedReceives(List<ClientResponse> responses, long now) {
    for (NetworkReceive receive : this.completedReceives) {
        String source = receive.source();
        InFlightRequest req = inFlightRequests.completeNext(source);

        // 解析响应头
        ResponseHeader header = ResponseHeader.parse(receive.payload());

        // 解析响应体
        Struct body = req.requestBuilder().readResponse(req.header.apiVersion(), receive.payload());
        AbstractResponse response = AbstractResponse.parseResponse(req.apiKey(), body);

        // 处理 ApiVersions 响应
        if (req.requestBuilder() instanceof ApiVersionsRequest.Builder) {
            handleApiVersionsResponse(response, source, now);
        }

        // 创建 ClientResponse
        ClientResponse clientResponse = new ClientResponse(
            req.header,
            req.callback,
            source,
            req.createdTimeMs,
            now,
            true,
            response,
            null
        );

        responses.add(clientResponse);
    }
}
```

### 4.4 回调触发

```java
// 在途请求完成后触发回调
public class InFlightRequest {

    public final RequestCompletionCallback callback;

    public InFlightRequest(ClientRequest clientRequest,
                           RequestHeader header,
                           boolean isInternalRequest,
                           Send send,
                           long createdTimeMs) {
        this.callback = clientRequest.callback();
        // ...
    }
}

// 回调接口
public interface RequestCompletionCallback {
    void onComplete(ClientResponse response);
}

// 使用示例：生产者发送回调
RequestCompletionCallback callback = new RequestCompletionCallback() {
    @Override
    public void onComplete(ClientResponse response) {
        if (response.wasDisconnected()) {
            // 处理断开连接
        } else if (response.hasError()) {
            // 处理错误
        } else {
            // 处理成功响应
        }
    }
};
```

---

## 5. 请求队列管理

### 5.1 InFlightRequests

**源码位置**: `clients/src/main/java/org/apache/kafka/clients/InFlightRequests.java`

```
┌─────────────────────────────────────────────────────────────────────┐
│                     InFlightRequests                                │
│                                                                     │
│  Node 1: ┌─────┐──┐ ┌─────┐──┐ ┌─────┐                             │
│          │ Req │──→│ Req │──→│ Req │──→ (max 5, can send more)    │
│          │  1  │  │ │  2  │  │ │  3  │                              │
│          └─────┘  │ └─────┘  │ └─────┘                              │
│                   │          │                                     │
│  Node 2: ┌─────┐──┐ ┌─────┐──┐ ┌─────┐──┐ ┌─────┐──┐ ┌─────┐      │
│          │ Req │──→│ Req │──→│ Req │──→│ Req │──→│ Req │      │
│          │  1  │  │ │  2  │  │ │  3  │  │ │  4  │  │ │  5  │      │
│          └─────┘  │ └─────┘  │ └─────┘  │ └─────┘  │ └─────┘      │
│                   │          │          │          │              │
│                   └──────────┴──────────┴──────────┴───────────────│
│                                (max 5, cannot send more)          │
└─────────────────────────────────────────────────────────────────────┘
```

```java
public final class InFlightRequests {

    // 每个节点对应的请求队列
    private final Map<String, Deque<InFlightRequest>> requests = new HashMap<>();

    // 每个连接的最大在途请求数
    private final int maxInFlightRequestsPerConnection;

    // 添加请求
    public void add(InFlightRequest request) {
        String destination = request.destination;
        Deque<InFlightRequest> reqs = requests.get(destination);
        if (reqs == null) {
            reqs = new ArrayDeque<>();
            requests.put(destination, reqs);
        }
        reqs.addFirst(request);
    }

    // 完成下一个请求（按 FIFO 顺序）
    public InFlightRequest completeNext(String destination) {
        Deque<InFlightRequest> reqs = requests.get(destination);
        return reqs.pollLast();  // 从队列尾部移除（最早发送的）
    }

    // 检查是否可以发送更多请求
    public boolean canSendMore(String destination) {
        Deque<InFlightRequest> queue = requests.get(destination);
        return queue == null || queue.isEmpty() ||
               (queue.peekFirst().request.completed() &&
                queue.size() < maxInFlightRequestsPerConnection);
    }

    // 获取最早发送的请求（用于超时检查）
    public InFlightRequest oldest(String destination) {
        Deque<InFlightRequest> reqs = requests.get(destination);
        return reqs != null ? reqs.peekLast() : null;
    }

    // 获取所有在途请求的数量
    public int count() {
        int total = 0;
        for (Deque<InFlightRequest> reqs : requests.values())
            total += reqs.size();
        return total;
    }

    // 清空某个节点的所有请求
    public List<InFlightRequest> clearAll(String destination) {
        Deque<InFlightRequest> reqs = requests.get(destination);
        if (reqs == null)
            return Collections.emptyList();

        List<InFlightRequest> result = new ArrayList<>(reqs);
        reqs.clear();
        return result;
    }
}
```

### 5.2 最大在途请求数

```java
// 配置选项
public static final String MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION =
    "max.in.flight.requests.per.connection";

// 默认值
public static final int DEFAULT_MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION = 5;

// 与幂等性的关系
// 当 enable.idempotence=true 时，max.in.flight.requests.per.connection 最大为 5
// 大于 1 时可能导致消息顺序问题（如果发生重试）

// 配置验证
if (idempotenceEnabled && maxInFlightRequests > 5) {
    throw new ConfigException("...");
}
```

### 5.3 队列满处理

```java
// 当队列满时的处理策略
public boolean ready(Node node, long now) {
    if (!isReady(node, now))
        return false;

    // 检查是否可以发送更多请求
    if (!inFlightRequests.canSendMore(node.idString())) {
        // 队列已满，等待响应返回
        log.trace("{} is not ready: too many in-flight requests",
            node.idString());
        return false;
    }

    return true;
}
```

### 5.4 请求超时清理

```java
// 处理超时请求
private void processTimedOutRequests(List<ClientResponse> responses, long now) {
    List<String> nodes = inFlightRequests.getNodesWithTimedOutRequests(now, requestTimeoutMs);

    for (String nodeId : nodes) {
        // 关闭超时的连接
        close(nodeId);

        // 更新指标
        sensors.requestTimeout.record();

        // 获取超时的请求
        List<InFlightRequest> timedOutRequests = inFlightRequests.clearAll(nodeId);

        for (InFlightRequest request : timedOutRequests) {
            // 创建超时响应
            ClientResponse response = new ClientResponse(
                request.header,
                request.callback,
                nodeId,
                request.createdTimeMs,
                now,
                false,
                null,
                new TimeoutException("Request timed out")
            );
            responses.add(response);
        }
    }
}
```

---

## 6. 超时与重试

### 6.1 request.timeout.ms

```java
// 请求超时配置
public static final String REQUEST_TIMEOUT_MS_CONFIG = "request.timeout.ms";
public static final int DEFAULT_REQUEST_TIMEOUT_MS = 30000;  // 30 秒

// 超时处理逻辑
private List<ClientResponse> poll(long timeout, long now) {
    // 1. 检查超时请求
    List<String> nodes = inFlightRequests.getNodesWithTimedOutRequests(now, requestTimeoutMs);

    for (String nodeId : nodes) {
        log.debug("Disconnecting from node {} due to request timeout.", nodeId);
        processTimeoutDisconnection(responses, nodeId, now);
    }

    // 2. 调用底层 selector
    long pollTimeout = Math.min(timeout, metadataBackoffMs);
    selector.poll(pollTimeout);

    // 3. 处理网络事件
    processCompletedReceives(responses, updatedNow);
    processCompletedSends(responses, updatedNow);
    processDisconnected(responses, updatedNow);

    return responses;
}
```

### 6.2 重试机制

```java
// NetworkClient 不直接处理重试，重试由上层实现（如 Sender）
// 但 NetworkClient 提供必要的支持

public class NetworkClient {

    // 处理可重试的错误
    private void handleErrorResponse(ClientResponse response, long now) {
        Errors error = Errors.forCode(response.responseBody().errorCode());

        // 某些错误需要断开连接并重试
        if (error == Errors.NOT_LEADER_OR_FOLLOWER ||
            error == Errors.LEADER_NOT_AVAILABLE) {

            // 请求元数据更新
            metadataUpdater.requestUpdate();

            // 断开连接，下次会重新连接
            disconnect(response.destination());
        }
    }
}

// Sender 中的重试逻辑
public class Sender implements Runnable {

    private int retries;  // 剩余重试次数

    private void completeBatch(ProducerBatch batch, ProduceResponse.PartitionResponse response) {
        if (response.error != Errors.NONE) {
            // 检查是否可以重试
            if (canRetry(response, batch, now)) {
                // 重试
                this.accumulator.reenqueue(batch, now);
                this.sensors.recordRetries(batch.topicPartition.topic(), batch.recordCount);
            } else {
                // 重试次数用尽，标记为失败
                batch.done(response.error.exception(), false);
            }
        } else {
            // 成功
            batch.done(null, false);
        }
    }

    private boolean canRetry(ProduceResponse.PartitionResponse response,
                             ProducerBatch batch,
                             long now) {
        return batch.attempts() < this.retries &&
               !batch.isDone() &&
               response.error.exception() instanceof RetriableException;
    }
}
```

### 6.3 退避策略

```java
// 指数退避策略
public class ClusterConnectionStates {

    private final long reconnectBackoffMs;
    private final long reconnectBackoffMaxMs;

    // 计算退避时间
    private long reconnectBackoffMs(int failedAttempts) {
        if (failedAttempts == 0)
            return reconnectBackoffMs;

        // 指数退避，但有上限
        long backoff = reconnectBackoffMs * (1L << Math.min(failedAttempts - 1, 15));
        return Math.min(backoff, reconnectBackoffMaxMs);
    }

    // 随机抖动，防止惊群效应
    private long withJitter(long baseMs) {
        return (long) (baseMs * (ThreadLocalRandom.current().nextDouble() + 0.5));
    }
}
```

### 6.4 不可重试错误

```java
// 不可重试错误类型
public enum Errors {
    // 认证错误 - 不重试
    UNKNOWN_TOPIC_OR_PARTITION(false),     // Topic 不存在
    TOPIC_AUTHORIZATION_FAILED(false),     // 权限不足
    GROUP_AUTHORIZATION_FAILED(false),
    CLUSTER_AUTHORIZATION_FAILED(false),
    INVALID_TOPIC_EXCEPTION(false),        // Topic 名称非法
    RECORD_TOO_LARGE(false),               // 消息太大
    INVALID_PRODUCER_EPOCH(false),         // 事务协调器错误
    TRANSACTIONAL_ID_AUTHORIZATION_FAILED(false);

    private final boolean retriable;

    Errors(boolean retriable) {
        this.retriable = retriable;
    }

    public boolean isRetriable() {
        return retriable;
    }
}

// 重试异常 vs 非重试异常
public class RetriableException extends ApiException {
    // 可重试：NOT_LEADER_OR_FOLLOWER, REQUEST_TIMED_OUT, etc.
}

public class NonRetriableException extends ApiException {
    // 不可重试：CORRUPT_MESSAGE, INVALID_MESSAGE, etc.
}
```

---

## 流程图总结

```
┌─────────────────────────────────────────────────────────────────────┐
│                    NetworkClient 完整流程                            │
└─────────────────────────────────────────────────────────────────────┘

     ┌─────────────┐
     │  应用层调用  │
     │ doSend()    │
     └──────┬──────┘
            │
            ▼
     ┌─────────────┐     否    ┌─────────────┐
     │ 连接已就绪?  │────────→│  发起连接    │
     └──────┬──────┘         └──────┬──────┘
            │ 是                     │
            │                        ▼
            │               ┌─────────────┐
            │               │ 版本协商完成?│
            │               │ 等待中      │
            │               └──────┬──────┘
            │                      │
            ▼                      │
     ┌─────────────┐               │
     │  序列化请求  │               │
     │  放入队列    │               │
     └──────┬──────┘               │
            │                      │
            ▼                      │
     ┌─────────────┐               │
     │  Selector   │               │
     │  poll()     │◄──────────────┘
     └──────┬──────┘
            │
     ┌──────┴──────┐
     │             │
     ▼             ▼
┌─────────┐ ┌─────────────┐
│发送完成? │ │接收到响应?  │
└────┬────┘ └──────┬──────┘
     │             │
     ▼             ▼
┌─────────┐ ┌─────────────┐
│触发回调  │ │ 反序列化     │
└─────────┘ └──────┬──────┘
                   │
                   ▼
            ┌─────────────┐
            │ 触发回调     │
            │ onComplete()│
            └─────────────┘
```

---

**上一篇**: [05. 序列化机制](./05-serialization.md)
**下一篇**: [07. 安全协议详解](./07-security-protocol.md)
