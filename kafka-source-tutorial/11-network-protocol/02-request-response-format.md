# 02. 请求响应格式详解

本文档深入分析 Kafka 网络协议的请求和响应格式，了解底层二进制通信协议的结构。

## 目录
- [1. 传输层帧格式](#1-传输层帧格式)
- [2. 请求头结构](#2-请求头结构)
- [3. 请求体结构](#3-请求体结构)
- [4. 响应头结构](#4-响应头结构)
- [5. 响应体结构](#5-响应体结构)
- [6. Correlation ID 机制](#6-correlation-id-机制)

---

## 1. 传输层帧格式

### 1.1 帧头结构

Kafka 使用自定义的帧格式，在 TCP 之上封装消息：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kafka TCP Frame Format                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┬────────────────────────────────────────────┐  │
│  │ Frame Length │              Message Payload               │  │
│  │  (4 bytes)   │              (variable length)             │  │
│  │  Big Endian  │                                            │  │
│  │  不包含自身  │                                            │  │
│  └──────────────┴────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

帧大小计算：
- Frame Length = 请求头长度 + 请求体长度
- 最大帧大小：默认 100MB (可配置)
```

### 1.2 大端序 vs 小端序

```java
/**
 * Kafka 协议使用大端序 (Big Endian)
 */
public class ByteUtils {

    /**
     * 写入大端序 int (4 bytes)
     */
    public static void writeInt(byte[] buffer, int offset, int value) {
        buffer[offset] = (byte) (value >> 24);
        buffer[offset + 1] = (byte) (value >> 16);
        buffer[offset + 2] = (byte) (value >> 8);
        buffer[offset + 3] = (byte) value;
    }

    /**
     * 读取大端序 int
     */
    public static int readInt(byte[] buffer, int offset) {
        return ((buffer[offset] & 0xFF) << 24) |
               ((buffer[offset + 1] & 0xFF) << 16) |
               ((buffer[offset + 2] & 0xFF) << 8) |
               (buffer[offset + 3] & 0xFF);
    }

    /**
     * 写入大端序 short (2 bytes)
     */
    public static void writeShort(byte[] buffer, int offset, short value) {
        buffer[offset] = (byte) (value >> 8);
        buffer[offset + 1] = (byte) value;
    }

    /**
     * 读取大端序 short
     */
    public static short readShort(byte[] buffer, int offset) {
        return (short) (((buffer[offset] & 0xFF) << 8) |
                        (buffer[offset + 1] & 0xFF));
    }
}
```

### 1.3 帧大小限制

```java
/**
 * Kafka 配置中的帧大小限制
 */
public class SocketServerConfigs {

    // Broker 端接收的最大请求大小
    // 默认 100MB
    public static final int SOCKET_REQUEST_MAX_BYTES_DEFAULT = 100 * 1024 * 1024;

    // 最大响应大小
    // 影响 Fetch 响应大小
    public static final int SOCKET_RECEIVE_BUFFER_BYTES_DEFAULT = 100 * 1024;

    // 客户端配置
    // max.request.size: 最大请求大小 (默认 1MB)
    // receive.buffer.bytes: 接收缓冲区 (默认 64KB)
}
```

### 1.4 TCP 粘包处理

```java
/**
 * 网络接收缓冲区处理粘包
 */
public class NetworkReceive implements Receive {

    private final ByteBuffer sizeBuffer;  // 4 bytes for size
    private ByteBuffer buffer;            // actual message buffer

    public long readFrom(ScatteringByteChannel channel) throws IOException {
        int read = 0;

        // 1. 先读取 4 字节长度
        if (sizeBuffer.hasRemaining()) {
            int bytesRead = channel.read(sizeBuffer);
            if (bytesRead < 0) {
                throw new EOFException();
            }
            read += bytesRead;

            // 长度读取完成，分配消息缓冲区
            if (!sizeBuffer.hasRemaining()) {
                sizeBuffer.flip();
                int messageSize = sizeBuffer.getInt();

                if (messageSize < 0) {
                    throw new InvalidReceiveException("Invalid message size: " + messageSize);
                }

                buffer = ByteBuffer.allocate(messageSize);
            }
        }

        // 2. 读取消息体
        if (buffer != null && buffer.hasRemaining()) {
            int bytesRead = channel.read(buffer);
            if (bytesRead < 0) {
                throw new EOFException();
            }
            read += bytesRead;
        }

        return read;
    }

    public boolean complete() {
        return buffer != null && !buffer.hasRemaining();
    }
}
```

---

## 2. 请求头结构

### 2.1 Request Header v0/v1/v2

Kafka 请求头经历了三个版本的演进：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Request Header Format                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Request Header v0/v1                                    │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ api_key          │ INT16  │ API 标识符 (如 0=Produce)    │   │
│  │ api_version      │ INT16  │ API 版本                     │   │
│  │ correlation_id   │ INT32  │ 请求关联 ID                  │   │
│  │ client_id        │ STRING │ 客户端标识 (可为空)          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Request Header v2 (Kafka 2.4+)                          │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ api_key          │ INT16  │ API 标识符                   │   │
│  │ api_version      │ INT16  │ API 版本                     │   │
│  │ correlation_id   │ INT32  │ 请求关联 ID                  │   │
│  │ client_id        │ STRING │ 客户端标识                   │   │
│  │ TAGGED_FIELDS    │ TAGS   │ 灵活字段 (可选)              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 API Key (2 bytes)

```java
/**
 * API Keys 定义
 */
public enum ApiKeys {
    PRODUCE(0, "Produce", ProduceRequestData.class),
    FETCH(1, "Fetch", FetchRequestData.class),
    LIST_OFFSETS(2, "ListOffsets", ListOffsetsRequestData.class),
    METADATA(3, "Metadata", MetadataRequestData.class),
    OFFSET_COMMIT(8, "OffsetCommit", OffsetCommitRequestData.class),
    OFFSET_FETCH(9, "OffsetFetch", OffsetFetchRequestData.class),
    FIND_COORDINATOR(10, "FindCoordinator", FindCoordinatorRequestData.class),
    JOIN_GROUP(11, "JoinGroup", JoinGroupRequestData.class),
    HEARTBEAT(12, "Heartbeat", HeartbeatRequestData.class),
    LEAVE_GROUP(13, "LeaveGroup", LeaveGroupRequestData.class),
    SYNC_GROUP(14, "SyncGroup", SyncGroupRequestData.class),
    API_VERSIONS(18, "ApiVersions", ApiVersionsRequestData.class),
    // ... 更多 API

    public final short id;
    public final String name;
    private final Class<?> requestSchema;

    ApiKeys(int id, String name, Class<?> requestSchema) {
        this.id = (short) id;
        this.name = name;
        this.requestSchema = requestSchema;
    }
}

// API Key 范围：
// -1: 保留，用于内部通信
// 0-999: 标准 Kafka API
// 1000+: 预留扩展
```

### 2.3 API Version (2 bytes)

```java
/**
 * API 版本管理
 */
public class ApiVersion {

    /**
     * 每个 API 有独立的版本号
     */
    public final short apiKey;
    public final short minVersion;    // 最小支持版本
    public final short maxVersion;    // 最大支持版本

    /**
     * Produce API 版本演进示例：
     *
     * v0 (0.8.x): 基础版本
     * v1 (0.9.0): 添加 timestamp
     * v2 (0.10.0): 添加 message format v1
     * v3 (0.11.0): 添加 transactionalId
     * v4-6: 增量改进
     * v7 (2.1.0): 添加 zstd 压缩
     * v8 (2.4.0): 灵活版本
     * v9 (3.0.0): 新增字段
     */
}

// 版本号分配规则：
// 0-9: 早期版本，固定字段
// 10+: 灵活版本支持 (Flexible Versions)
```

### 2.4 Correlation ID (4 bytes)

```java
/**
 * Correlation ID 生成和管理
 */
public class RequestContext {

    private static final AtomicInteger correlationIdCounter = new AtomicInteger(0);

    /**
     * 生成新的 Correlation ID
     */
    public static int nextCorrelationId() {
        return correlationIdCounter.getAndIncrement();
    }

    /**
     * Correlation ID 用途：
     * 1. 匹配请求和响应
     * 2. 追踪请求链路
     * 3. 日志关联
     */
}
```

### 2.5 Client ID (字符串)

```
Client ID 编码格式：

┌────────────────────────────────────────────┐
│ 长度 (2 bytes) │ 内容 (N bytes) │ NULL?   │
├────────────────────────────────────────────┤
│     N         │    string      │  -1     │
│    -1         │      -         │  NULL   │
└────────────────────────────────────────────┘

示例：
Client ID = "producer-1"
编码：00 0A 70 72 6F 64 75 63 65 72 2D 31
      │长度│  p  r  o  d  u  c  e  r  -  1
      (10) │
```

### 2.6 Tagged Fields (灵活版本)

```java
/**
 * Kafka 2.4+ 引入的灵活字段机制
 */
public class RawTaggedField {

    private final int tag;       // 字段标签 (Varint)
    private final byte[] data;   // 字段数据

    /**
     * 编码格式：
     *
     * ┌─────────────────────────────────────────────┐
     * │ numTaggedFields  │ Varint  │ 标签字段数量   │
     * ├──────────────────┼─────────┼────────────────┤
     * │ tag              │ Varint  │ 字段标签       │
     * │ length           │ Varint  │ 数据长度       │
     * │ data             │ bytes   │ 实际数据       │
     * └──────────────────┴─────────┴────────────────┘
     *
     * 优势：
     * 1. 向前兼容：旧客户端可忽略未知标签
     * 2. 向后兼容：新客户端可为缺失标签使用默认值
     * 3. 无需增加版本号即可扩展
     */
}
```

---

## 3. 请求体结构

### 3.1 请求体编码规则

```java
/**
 * 请求体基础编码接口
 */
public interface ApiMessage {

    /**
     * 写入到 ByteBuffer
     */
    void write(Writable writable, short version);

    /**
     * 从 ByteBuffer 读取
     */
    void read(Readable readable, short version);

    /**
     * 获取 API Key
     */
    short apiKey();

    /**
     * 获取最低支持版本
     */
    short lowestSupportedVersion();

    /**
     * 获取最高支持版本
     */
    short highestSupportedVersion();
}
```

### 3.2 常用数据类型编码

```
┌─────────────────────────────────────────────────────────────────┐
│                    基本数据类型编码                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  类型           │ 大小    │ 说明                                │
│  ───────────────┼─────────┼─────────────────────────────────────│
│  INT8           │ 1 byte  │ 有符号字节                          │
│  INT16          │ 2 bytes │ 大端序短整型                        │
│  INT32          │ 4 bytes │ 大端序整型                          │
│  INT64          │ 8 bytes │ 大端序长整型                        │
│  BOOLEAN        │ 1 byte  │ 0=false, 1=true                     │
│  STRING         │ 2+n     │ 长度(2) + UTF-8 内容                │
│  NULLABLE_STRING│ 2+n     │ -1 表示 null                        │
│  BYTES          │ 4+n     │ 长度(4) + 字节内容                  │
│  VARINT         │ 1-5     │ 变长整型 (ZigZag + Varint)          │
│  VARLONG        │ 1-10    │ 变长长整型                          │
│  ARRAY          │ 4+n*size│ 长度(4) + 元素数组                  │
│  COMPACT_STRING │ 1+n     │ 紧凑字符串 (长度使用 Varint)        │
│  COMPACT_ARRAY  │ Varint  │ 紧凑数组                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Compact Strings/Arrays

```java
/**
 * 紧凑格式编码（灵活版本使用）
 */
public class CompactEncoding {

    /**
     * 紧凑字符串编码
     *
     * 格式：length(Varint) + data
     * length = N + 1 (0 表示 null, 1 表示空字符串)
     */
    public static void writeCompactString(ByteBuffer buffer, String str) {
        if (str == null) {
            ByteUtils.writeVarint(buffer, 0);
        } else {
            byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
            ByteUtils.writeVarint(buffer, bytes.length + 1);
            buffer.put(bytes);
        }
    }

    /**
     * 紧凑数组编码
     *
     * 格式：numElements(Varint) + elements
     * numElements = N + 1 (0 表示 null)
     */
    public static void writeCompactArray(ByteBuffer buffer,
                                         List<?> array,
                                         Consumer<Object> elementWriter) {
        if (array == null) {
            ByteUtils.writeVarint(buffer, 0);
        } else {
            ByteUtils.writeVarint(buffer, array.size() + 1);
            for (Object element : array) {
                elementWriter.accept(element);
            }
        }
    }
}
```

### 3.4 Nullable 字段处理

```java
/**
 * 可空字段编码
 */
public class NullableEncoding {

    /**
     * 可空字符串
     */
    public static void writeNullableString(ByteBuffer buffer, String str) {
        if (str == null) {
            buffer.putShort((short) -1);
        } else {
            byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
            buffer.putShort((short) bytes.length);
            buffer.put(bytes);
        }
    }

    public static String readNullableString(ByteBuffer buffer) {
        short length = buffer.getShort();
        if (length == -1) {
            return null;
        }
        byte[] bytes = new byte[length];
        buffer.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /**
     * 可空字节数组
     */
    public static void writeNullableBytes(ByteBuffer buffer, byte[] bytes) {
        if (bytes == null) {
            buffer.putInt(-1);
        } else {
            buffer.putInt(bytes.length);
            buffer.put(bytes);
        }
    }
}
```

---

## 4. 响应头结构

### 4.1 Response Header v0/v1

```
┌─────────────────────────────────────────────────────────────────┐
│                    Response Header Format                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Response Header v0                                      │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ correlation_id   │ INT32  │ 对应请求的关联 ID            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Response Header v1 (Kafka 0.11+)                        │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ correlation_id   │ INT32  │ 对应请求的关联 ID            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Response Header v2 (Kafka 2.4+)                         │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ correlation_id   │ INT32  │ 对应请求的关联 ID            │   │
│  │ TAGGED_FIELDS    │ TAGS   │ 灵活字段 (可选)              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Correlation ID

```java
/**
 * 响应头只包含 Correlation ID
 */
public class ResponseHeader {

    private final int correlationId;
    private final short headerVersion;

    public ResponseHeader(int correlationId, short headerVersion) {
        this.correlationId = correlationId;
        this.headerVersion = headerVersion;
    }

    public int correlationId() {
        return correlationId;
    }

    public int size() {
        // v0: 4 bytes
        // v1: 4 bytes (与 v0 相同，但编码方式不同)
        // v2: 4 bytes + tagged fields
        return 4;
    }
}
```

### 4.3 Tagged Fields

```java
/**
 * 响应头中的灵活字段
 */
public class ResponseHeaderV2 extends ResponseHeader {

    private final List<RawTaggedField> taggedFields;

    public ResponseHeaderV2(int correlationId, List<RawTaggedField> taggedFields) {
        super(correlationId, (short) 2);
        this.taggedFields = taggedFields;
    }

    @Override
    public void write(ByteBuffer buffer) {
        buffer.putInt(correlationId());

        // 写入 tagged fields
        if (!taggedFields.isEmpty()) {
            ByteUtils.writeVarint(buffer, taggedFields.size());
            for (RawTaggedField field : taggedFields) {
                ByteUtils.writeVarint(buffer, field.tag());
                ByteUtils.writeVarint(buffer, field.data().length);
                buffer.put(field.data());
            }
        } else {
            ByteUtils.writeVarint(buffer, 0);
        }
    }
}
```

---

## 5. 响应体结构

### 5.1 响应体编码规则

```java
/**
 * 响应体基类
 */
public abstract class AbstractResponse implements AbstractRequestResponse {

    /**
     * 错误码处理
     */
    public abstract Errors error();

    /**
     * 写入响应
     */
    public ByteBuffer serialize(short version) {
        ResponseHeader header = new ResponseHeader(correlationId,
            headerVersion(version));
        return serialize(header, version);
    }

    /**
     * 获取错误响应
     */
    public abstract AbstractResponse getErrorResponse(int throttleTimeMs, Throwable e);
}
```

### 5.2 Error Code 编码

```java
/**
 * Kafka 错误码定义
 */
public enum Errors {
    // 成功
    NONE(0, null),

    // 未知错误
    UNKNOWN_SERVER_ERROR(-1, UnknownServerException.class),

    // 偏移相关
    OFFSET_OUT_OF_RANGE(1, OffsetOutOfRangeException.class),
    NO_OFFSET_FOR_PARTITION(6, NoOffsetForPartitionException.class),

    // 主题相关
    UNKNOWN_TOPIC_OR_PARTITION(3, UnknownTopicOrPartitionException.class),
    TOPIC_AUTHORIZATION_FAILED(29, TopicAuthorizationException.class),

    // 消费组相关
    UNKNOWN_MEMBER_ID(25, UnknownMemberIdException.class),
    ILLEGAL_GENERATION(22, IllegalGenerationException.class),
    REBALANCE_IN_PROGRESS(27, RebalanceInProgressException.class),

    // 事务相关
    TRANSACTIONAL_ID_AUTHORIZATION_FAILED(127, TransactionalIdAuthorizationException.class),
    TRANSACTION_COORDINATOR_FENCED(126, TransactionCoordinatorFencedException.class),

    // ... 更多错误码

    private final short code;
    private final Class<?> exceptionClass;

    Errors(int code, Class<?> exceptionClass) {
        this.code = (short) code;
        this.exceptionClass = exceptionClass;
    }

    public short code() {
        return code;
    }

    public ApiException exception() {
        // 根据错误码创建对应异常
    }
}
```

### 5.3 Throttle Time

```java
/**
 * 限流时间字段
 */
public class ApiVersionsResponse {

    private final int throttleTimeMs;

    /**
     * Throttle Time 说明：
     *
     * 当 Broker 负载过高时，可以在响应中添加 throttleTimeMs
     * 客户端收到后应该暂停相应时间后再发送下一个请求
     *
     * 适用场景：
     * 1. 客户端请求频率过高
     * 2. Broker CPU/内存压力
     * 3. 配额限制
     */
}

// 客户端限流处理
if (response.throttleTimeMs() > 0) {
    Thread.sleep(response.throttleTimeMs());
}
```

### 5.4 响应大小限制

```java
/**
 * 响应大小限制处理
 */
public class FetchResponse {

    /**
     * 当响应过大时的处理：
     *
     * 1. 分片返回 (Fetch v13+ 支持)
     * 2. 截断消息
     * 3. 返回错误 (MESSAGE_TOO_LARGE)
     */

    // 客户端配置
    // fetch.max.bytes: 最大 Fetch 响应大小 (默认 50MB)
    // max.partition.fetch.bytes: 单分区最大 (默认 1MB)
}
```

---

## 6. Correlation ID 机制

### 6.1 作用与原理

```
┌─────────────────────────────────────────────────────────────────┐
│                  Correlation ID 工作原理                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Client                           Server                       │
│     │                                │                          │
│     │  Request (correlation_id=42)   │                          │
│     │ ──────────────────────────────▶│                          │
│     │                                │                          │
│     │         ┌────────────────────┐ │                          │
│     │         │ InFlightRequests   │ │                          │
│     │         │ {42 -> callback}  │ │                          │
│     │         └────────────────────┘ │                          │
│     │                                │                          │
│     │  Response (correlation_id=42)  │                          │
│     │ ◀──────────────────────────────│                          │
│     │                                │                          │
│     │  查找 callback 并触发          │                          │
│     │                                │                          │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 生成与匹配

```java
/**
 * Correlation ID 生成器
 */
public class CorrelationIdGenerator {

    private final AtomicInteger counter = new AtomicInteger(0);

    public int next() {
        return counter.getAndIncrement();
    }

    /**
     * 重置（连接断开后）
     */
    public void reset() {
        counter.set(0);
    }
}

/**
 * 请求-响应匹配
 */
public class InFlightRequests {

    private final Map<Integer, InFlightRequest> requests = new HashMap<>();

    public void add(InFlightRequest request) {
        requests.put(request.correlationId, request);
    }

    public InFlightRequest complete(int correlationId) {
        return requests.remove(correlationId);
    }

    /**
     * 处理响应
     */
    public void handleResponse(ResponseHeader header, ByteBuffer body) {
        int correlationId = header.correlationId();
        InFlightRequest request = complete(correlationId);

        if (request != null) {
            request.callback().onComplete(body);
        } else {
            log.error("Unexpected response with correlationId: {}", correlationId);
        }
    }
}
```

### 6.3 InFlightRequests 管理

```java
/**
 * 在途请求管理
 */
public final class InFlightRequests {

    // 每个连接的最大在途请求数
    private final int maxInFlightRequestsPerConnection;

    // 每个节点的在途请求队列
    private final Map<String, Deque<NetworkClient.InFlightRequest>> requests;

    /**
     * 添加请求
     */
    public void add(InFlightRequest request) {
        String nodeId = request.destination();
        Deque<InFlightRequest> deque = requests.computeIfAbsent(
            nodeId, k -> new ArrayDeque<>());
        deque.addLast(request);
    }

    /**
     * 移除已完成的请求
     */
    public InFlightRequest completeNext(String nodeId) {
        Deque<InFlightRequest> deque = requests.get(nodeId);
        return deque != null ? deque.pollFirst() : null;
    }

    /**
     * 检查是否可以发送新请求
     */
    public boolean canSendMore(String nodeId) {
        Deque<InFlightRequest> deque = requests.get(nodeId);
        return deque == null || deque.size() < maxInFlightRequestsPerConnection;
    }

    /**
     * 获取在途请求数量
     */
    public int count() {
        return requests.values().stream()
            .mapToInt(Collection::size)
            .sum();
    }
}
```

### 6.4 超时处理

```java
/**
 * 请求超时检测
 */
public class InFlightRequests {

    /**
     * 检查并移除超时请求
     */
    public List<InFlightRequest> getExpiredRequests(long now) {
        List<InFlightRequest> expired = new ArrayList<>();

        for (Deque<InFlightRequest> deque : requests.values()) {
            Iterator<InFlightRequest> iter = deque.iterator();

            while (iter.hasNext()) {
                InFlightRequest request = iter.next();

                if (request.isExpired(now)) {
                    iter.remove();
                    expired.add(request);
                } else {
                    // 队列是有序的，后面的请求发送时间更晚
                    break;
                }
            }
        }

        return expired;
    }
}

/**
 * 请求超时配置
 */
public class ClientConfig {
    // request.timeout.ms: 请求超时时间 (默认 30s)
    // 从发送请求到收到响应的最大时间
}
```

---

**上一章**: [01. Kafka 网络协议概述](./01-protocol-overview.md)
**下一章**: [03. Kafka 消息格式演进](./03-message-format.md)
