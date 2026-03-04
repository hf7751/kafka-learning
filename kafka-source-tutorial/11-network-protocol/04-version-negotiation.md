# 04. 协议版本协商机制

本文档深入分析 Kafka 的协议版本协商机制，了解客户端和 Broker 如何就 API 版本达成一致。

## 目录
- [1. 版本协商概述](#1-版本协商概述)
- [2. ApiVersions 请求](#2-apiversions-请求)
- [3. 版本选择策略](#3-版本选择策略)
- [4. 灵活版本 (Flexible Versions)](#4-灵活版本-flexible-versions)
- [5. 版本兼容性](#5-版本兼容性)

---

## 1. 版本协商概述

### 1.1 为什么需要版本协商

| 问题 | 说明 |
|-----|------|
| **功能演进** | Kafka 不断添加新功能和优化 |
| **向后兼容** | 新老版本需要共存 |
| **平滑升级** | 支持滚动升级不停机 |
| **错误避免** | 防止使用不支持的特性 |

```
版本协商的核心价值：

Client (v3.0)                          Broker (v3.0)
   │                                        │
   │ ───── "我支持 Produce v0-v9" ───────▶ │
   │                                        │
   │ ◀──── "我支持 Produce v0-v9" ──────── │
   │                                        │
   │ ───── "使用 Produce v9" ────────────▶ │
   │                                        │
   │ ◀──── 使用 v9 格式响应 ─────────────── │

协商结果：双方使用最高共同版本 v9
```

### 1.2 协商流程

```
连接建立后的版本协商流程：

1. TCP 连接建立
   Client ───────────────────────────────▶ Broker

2. 发送 ApiVersions 请求
   Client ─── ApiVersionsRequest ───────▶ Broker

3. 返回支持的版本列表
   Client ◀── ApiVersionsResponse ─────── Broker

4. 后续请求使用协商版本
   Client ─── Request (version=X) ──────▶ Broker
            (X = min(client_max, broker_max))
```

### 1.3 协商时机

```java
/**
 * 版本协商时机
 */
public class ConnectionManager {

    /**
     * 1. 首次连接时
     */
    public void onConnectionEstablished(Node node) {
        // 发送 ApiVersions 请求
        ApiVersionsRequest request = new ApiVersionsRequest.Builder().build();
        sendRequest(node, request);
    }

    /**
     * 2. 版本过期时（Kafka 2.4+）
     */
    public void checkApiVersionsExpiration() {
        for (Node node : connectedNodes) {
            if (apiVersions.get(node).isExpired()) {
                // 重新协商版本
                refreshApiVersions(node);
            }
        }
    }

    /**
     * 3. 收到 VERSION_MISMATCH 错误时
     */
    public void onVersionMismatch(Node node, short apiKey) {
        // 降级到更低的版本重试
        short lowerVersion = apiVersions.get(node).version(apiKey) - 1;
        retryWithVersion(node, apiKey, lowerVersion);
    }
}
```

---

## 2. ApiVersions 请求

### 2.1 ApiVersionsRequest 结构

```
┌─────────────────────────────────────────────────────────────────┐
│                   ApiVersions Request                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Request Header                                                 │
│  ├─ api_key: 18 (ApiVersions)                                   │
│  ├─ api_version: 0, 1, 2, or 3                                  │
│  ├─ correlation_id: INT32                                       │
│  └─ client_id: STRING                                           │
│                                                                 │
│  Request Body (v0)                                              │
│  └─ (空) - 无请求体                                             │
│                                                                 │
│  Request Body (v1-v2)                                           │
│  └─ client_software_name: COMPACT_STRING (客户端名称)           │
│  └─ client_software_version: COMPACT_STRING (客户端版本)        │
│  └─ TAGGED_FIELDS                                               │
│                                                                 │
│  Request Body (v3)                                              │
│  └─ client_software_name: COMPACT_STRING                        │
│  └─ client_software_version: COMPACT_STRING                     │
│  └─ include_feature_flags: BOOLEAN (是否包含特性标志)           │
│  └─ TAGGED_FIELDS                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 ApiVersionsResponse 结构

```
┌─────────────────────────────────────────────────────────────────┐
│                   ApiVersions Response                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Response Header                                                │
│  └─ correlation_id: INT32                                       │
│                                                                 │
│  Response Body                                                  │
│  ├─ error_code: INT16 (0 = 成功)                                │
│  ├─ api_versions[]:                                             │
│  │   ├─ api_key: INT16 (API 标识)                               │
│  │   ├─ min_version: INT16 (最小支持版本)                       │
│  │   ├─ max_version: INT16 (最大支持版本)                       │
│  │   └─ TAGGED_FIELDS (v3+)                                     │
│  ├─ throttle_time_ms: INT32 (v1+)                               │
│  ├─ supported_features[]: (v3+)                                 │
│  │   ├─ name: COMPACT_STRING                                    │
│  │   ├─ min_version: INT16                                      │
│  │   └─ max_version: INT16                                      │
│  ├─ finalized_features_epoch: INT64 (v3+)                       │
│  ├─ finalized_features[]: (v3+)                                 │
│  └─ TAGGED_FIELDS (v3+)                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Broker 支持的版本列表

```java
/**
 * Broker 端的 API 版本注册
 */
public class ApiVersionManager {

    /**
     * 每个 API 支持的版本范围
     */
    private static final Map<ApiKeys, ApiVersion> API_VERSIONS = new EnumMap<>(ApiKeys.class);

    static {
        // Produce API
        API_VERSIONS.put(ApiKeys.PRODUCE, new ApiVersion(
            ApiKeys.PRODUCE.id,
            (short) 0,   // min version
            (short) 9    // max version (Kafka 3.0)
        ));

        // Fetch API
        API_VERSIONS.put(ApiKeys.FETCH, new ApiVersion(
            ApiKeys.FETCH.id,
            (short) 0,
            (short) 15   // max version
        ));

        // Metadata API
        API_VERSIONS.put(ApiKeys.METADATA, new ApiVersion(
            ApiKeys.METADATA.id,
            (short) 0,
            (short) 12   // max version
        ));

        // ApiVersions API
        API_VERSIONS.put(ApiKeys.API_VERSIONS, new ApiVersion(
            ApiKeys.API_VERSIONS.id,
            (short) 0,
            (short) 3    // max version
        ));

        // ... 其他 API
    }

    /**
     * 获取支持的版本
     */
    public ApiVersion getApiVersion(ApiKeys apiKey) {
        return API_VERSIONS.get(apiKey);
    }
}

/**
 * API 版本信息
 */
public class ApiVersion {
    public final short apiKey;
    public final short minVersion;
    public final short maxVersion;

    public ApiVersion(short apiKey, short minVersion, short maxVersion) {
        this.apiKey = apiKey;
        this.minVersion = minVersion;
        this.maxVersion = maxVersion;
    }
}
```

### 2.4 客户端缓存机制

```java
/**
 * 客户端缓存 API 版本信息
 */
public class ApiVersions {

    // 缓存每个节点的 API 版本
    private final Map<Node, NodeApiVersions> nodeApiVersions = new HashMap<>();

    // 缓存过期时间（默认 10 分钟）
    private static final long API_VERSIONS_EXPIRATION_MS = 10 * 60 * 1000;

    /**
     * 更新节点的 API 版本
     */
    public void update(Node node, ApiVersionsResponse response) {
        nodeApiVersions.put(node, new NodeApiVersions(
            response.apiVersions(),
            System.currentTimeMillis()
        ));
    }

    /**
     * 获取节点支持的版本
     */
    public short maxUsableVersion(Node node, ApiKeys apiKey) {
        NodeApiVersions versions = nodeApiVersions.get(node);
        if (versions == null || versions.isExpired()) {
            return UNKNOWN_VERSION;
        }
        return versions.maxVersion(apiKey);
    }

    /**
     * 选择双方支持的最高版本
     */
    public short selectVersion(Node node, ApiKeys apiKey) {
        short clientMax = apiKey.latestVersion();
        short brokerMax = maxUsableVersion(node, apiKey);

        if (brokerMax == UNKNOWN_VERSION) {
            return apiKey.oldestVersion(); // 降级到最低版本
        }

        return (short) Math.min(clientMax, brokerMax);
    }
}
```

---

## 3. 版本选择策略

### 3.1 最优版本选择

```java
/**
 * 版本选择策略
 */
public class VersionSelector {

    /**
     * 选择最优版本
     *
     * 策略：选择双方都支持的最高版本
     */
    public static short selectVersion(
            short clientMin, short clientMax,
            short brokerMin, short brokerMax) {

        // 检查是否有交集
        if (clientMax < brokerMin || brokerMax < clientMin) {
            throw new UnsupportedVersionException(
                "No common version found. " +
                "Client: [" + clientMin + ", " + clientMax + "], " +
                "Broker: [" + brokerMin + ", " + brokerMax + "]"
            );
        }

        // 返回最高共同版本
        return (short) Math.min(clientMax, brokerMax);
    }

    /**
     * 实际选择示例
     */
    public void example() {
        // 场景 1: 客户端支持 v0-v5，Broker 支持 v0-v3
        // 结果：使用 v3
        short v1 = selectVersion((short) 0, (short) 5, (short) 0, (short) 3);
        // v1 = 3

        // 场景 2: 客户端支持 v2-v5，Broker 支持 v0-v3
        // 结果：使用 v3
        short v2 = selectVersion((short) 2, (short) 5, (short) 0, (short) 3);
        // v2 = 3

        // 场景 3: 客户端支持 v4-v5，Broker 支持 v0-v3
        // 结果：抛出异常（无交集）
        try {
            short v3 = selectVersion((short) 4, (short) 5, (short) 0, (short) 3);
        } catch (UnsupportedVersionException e) {
            // 处理不兼容情况
        }
    }
}
```

### 3.2 降级机制

```java
/**
 * 版本降级处理
 */
public class VersionFallbackHandler {

    /**
     * 发送请求，自动降级
     */
    public <T> T sendWithFallback(Node node, ApiKeys apiKey,
                                   AbstractRequest.Builder<?> requestBuilder) {
        ApiVersions apiVersions = getApiVersions(node);
        short version = apiVersions.selectVersion(node, apiKey);

        while (version >= apiKey.oldestVersion()) {
            try {
                // 尝试使用当前版本发送
                return sendRequest(node, requestBuilder.build(version));
            } catch (UnsupportedVersionException e) {
                log.warn("Version {} not supported, trying lower version", version);
                version--; // 降级
            }
        }

        throw new UnsupportedVersionException(
            "No supported version found for " + apiKey.name()
        );
    }

    /**
     * Produce 请求降级示例
     */
    public void produceWithFallback(Node node, ProducerRecord record) {
        ApiVersions apiVersions = getApiVersions(node);
        short version = apiVersions.selectVersion(node, ApiKeys.PRODUCE);

        ProduceRequest.Builder builder = new ProduceRequest.Builder(record);

        // 如果版本 < 3，移除 transactionalId
        if (version < 3) {
            builder.setTransactionalId(null);
        }

        // 如果版本 < 5，使用旧的时间戳类型
        if (version < 5) {
            builder.useLegacyTimestamp();
        }

        sendRequest(node, builder.build(version));
    }
}
```

### 3.3 不兼容版本处理

```java
/**
 * 版本不兼容处理
 */
public class VersionCompatibilityHandler {

    /**
     * 检查版本兼容性
     */
    public void checkCompatibility(Node node, ApiKeys apiKey) {
        short brokerMaxVersion = apiVersions.maxUsableVersion(node, apiKey);
        short clientMinVersion = apiKey.oldestVersion();

        if (brokerMaxVersion < clientMinVersion) {
            // Broker 版本太旧
            throw new BrokerVersionTooOldException(
                String.format(
                    "Broker %s does not support %s API (max version: %d), " +
                    "minimum required version is %d",
                    node, apiKey.name(), brokerMaxVersion, clientMinVersion
                )
            );
        }
    }

    /**
     * 功能可用性检查
     */
    public boolean isFeatureAvailable(Node node, Feature feature) {
        short requiredVersion = feature.requiredVersion();
        short availableVersion = apiVersions.maxUsableVersion(node, feature.apiKey());

        return availableVersion >= requiredVersion;
    }

    /**
     * 示例：检查事务功能是否可用
     */
    public boolean isTransactionsAvailable(Node node) {
        // 事务需要 Produce API v3+
        short produceVersion = apiVersions.maxUsableVersion(node, ApiKeys.PRODUCE);
        return produceVersion >= 3;
    }
}
```

### 3.4 NodeApiVersions 类分析

```java
/**
 * 节点的 API 版本信息
 */
public class NodeApiVersions {

    // API 版本映射
    private final Map<Short, ApiVersion> supportedVersions;

    // 缓存时间
    private final long createdTimeMs;

    // 过期时间
    private static final long EXPIRATION_TIME_MS = 10 * 60 * 1000; // 10 分钟

    public NodeApiVersions(Collection<ApiVersion> versions) {
        this.supportedVersions = versions.stream()
            .collect(Collectors.toMap(v -> v.apiKey, v -> v));
        this.createdTimeMs = System.currentTimeMillis();
    }

    /**
     * 获取指定 API 的最大版本
     */
    public short maxVersion(ApiKeys apiKey) {
        ApiVersion version = supportedVersions.get(apiKey.id);
        return version != null ? version.maxVersion : UNKNOWN_VERSION;
    }

    /**
     * 检查是否过期
     */
    public boolean isExpired() {
        return System.currentTimeMillis() - createdTimeMs > EXPIRATION_TIME_MS;
    }

    /**
     * 构建描述字符串（用于日志）
     */
    public String describe() {
        StringBuilder sb = new StringBuilder();
        for (ApiVersion version : supportedVersions.values()) {
            sb.append(String.format("%s(%d-%d), ",
                ApiKeys.forId(version.apiKey).name,
                version.minVersion,
                version.maxVersion));
        }
        return sb.toString();
    }
}
```

---

## 4. 灵活版本 (Flexible Versions)

### 4.1 什么是灵活版本

```
灵活版本 (Flexible Versions) - Kafka 2.4+ 引入

传统版本：
┌─────────────────────────────────────────────────────────────────┐
│ API v0: 固定字段                                                 │
│ API v1: 添加字段1                                                │
│ API v2: 添加字段2                                                │
│                                                                 │
│ 问题：每次添加字段都需要新版本，版本号爆炸                       │
└─────────────────────────────────────────────────────────────────┘

灵活版本：
┌─────────────────────────────────────────────────────────────────┐
│ API v10+: 灵活版本                                               │
│                                                                 │
│ 支持 Tagged Fields：                                             │
│ - 可选字段                                                       │
│ - 向前兼容                                                       │
│ - 向后兼容                                                       │
│                                                                 │
│ 优势：无需新版本即可添加字段                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Tagged Fields 机制

```java
/**
 * Tagged Field 定义
 */
public class RawTaggedField {
    private final int tag;       // 字段标签（唯一标识）
    private final byte[] data;   // 字段数据

    public RawTaggedField(int tag, byte[] data) {
        this.tag = tag;
        this.data = data;
    }
}

/**
 * Tagged Fields 编码
 */
public class TaggedFields {

    /**
     * 编码格式：
     *
     * ┌─────────────────────────────────────────────┐
     * │ numTaggedFields  │ Varint  │ 字段数量        │
     * ├──────────────────┼─────────┼────────────────┤
     * │ tag              │ Varint  │ 字段标签        │
     * │ length           │ Varint  │ 数据长度        │
     * │ data             │ bytes   │ 实际数据        │
     * ├──────────────────┼─────────┼────────────────┤
     * │ tag              │ Varint  │ 下一个字段...   │
     * │ ...              │ ...     │                │
     * └──────────────────┴─────────┴────────────────┘
     */

    public static void write(ByteBuffer buffer,
                             List<RawTaggedField> taggedFields) {
        // 按 tag 排序（确定性编码）
        List<RawTaggedField> sorted = taggedFields.stream()
            .sorted(Comparator.comparingInt(RawTaggedField::tag))
            .collect(Collectors.toList());

        // 写入数量
        ByteUtils.writeVarint(buffer, sorted.size());

        // 写入每个字段
        for (RawTaggedField field : sorted) {
            ByteUtils.writeVarint(buffer, field.tag());
            ByteUtils.writeVarint(buffer, field.data().length);
            buffer.put(field.data());
        }
    }

    public static List<RawTaggedField> read(ByteBuffer buffer) {
        int numFields = ByteUtils.readVarint(buffer);
        List<RawTaggedField> result = new ArrayList<>(numFields);

        for (int i = 0; i < numFields; i++) {
            int tag = ByteUtils.readVarint(buffer);
            int length = ByteUtils.readVarint(buffer);
            byte[] data = new byte[length];
            buffer.get(data);
            result.add(new RawTaggedField(tag, data));
        }

        return result;
    }
}
```

### 4.3 与固定版本的对比

| 特性 | 固定版本 | 灵活版本 |
|-----|---------|---------|
| 版本号增长 | 快 | 慢 |
| 添加字段 | 需要新版本 | 使用 Tagged Field |
| 向前兼容 | 难 | 容易 |
| 向后兼容 | 依赖实现 | 自然支持 |
| 编码复杂度 | 简单 | 较复杂 |
| 空间效率 | 固定 | 按需分配 |

### 4.4 向前兼容性提升

```java
/**
 * 灵活版本的向前兼容示例
 */
public class FlexibleVersionExample {

    /**
     * 旧客户端发送请求到新 Broker
     *
     * 场景：新 Broker 支持新的可选字段，旧客户端不知道
     */
    public void oldClientToNewBroker() {
        // 旧客户端发送的请求（没有新字段）
        ProduceRequest oldRequest = new ProduceRequest.Builder()
            .setTopic("topic")
            .setValue("data")
            // 没有设置 newFeature 字段
            .build();

        // 新 Broker 接收：
        // - 解析已知字段
        // - Tagged Fields 中包含 unknown tags，忽略
        // - 新字段使用默认值
    }

    /**
     * 新客户端发送请求到旧 Broker
     *
     * 场景：新客户端使用新功能，旧 Broker 不支持
     */
    public void newClientToOldBroker() {
        // 新客户端发送请求
        ProduceRequest newRequest = new ProduceRequest.Builder()
            .setTopic("topic")
            .setValue("data")
            .setNewFeature("feature")  // 新功能
            .build();

        // 旧 Broker 接收：
        // - 解析已知字段
        // - Tagged Fields 被忽略（旧 Broker 不认识）
        // - 如果新功能是可选的，正常处理
        // - 如果新功能是必须的，返回错误
    }
}
```

---

## 5. 版本兼容性

### 5.1 向后兼容 (Backward)

```java
/**
 * 向后兼容：新版本可以处理旧格式
 *
 * 实现方式：
 * 1. 新增字段有默认值
 * 2. 旧版本没有的字段使用默认值
 */
public class BackwardCompatibility {

    /**
     * Produce Request 演进示例
     */
    public class ProduceRequestV0 {
        String topic;
        byte[] key;
        byte[] value;
    }

    public class ProduceRequestV1 extends ProduceRequestV0 {
        long timestamp;  // 新增，默认 0
    }

    public class ProduceRequestV2 extends ProduceRequestV1 {
        byte magic = 1;  // 新增，默认值
    }

    /**
     * 解析时处理缺失字段
     */
    public ProduceRequest parseRequest(ByteBuffer buffer, short version) {
        ProduceRequest request = new ProduceRequest();

        // 所有版本都有的字段
        request.topic = readString(buffer);
        request.key = readBytes(buffer);
        request.value = readBytes(buffer);

        // v1+ 才有的字段
        if (version >= 1) {
            request.timestamp = buffer.getLong();
        } else {
            request.timestamp = 0L; // 默认值
        }

        // v2+ 才有的字段
        if (version >= 2) {
            request.magic = buffer.get();
        } else {
            request.magic = 0; // 默认值
        }

        return request;
    }
}
```

### 5.2 向前兼容 (Forward)

```java
/**
 * 向前兼容：旧版本可以处理新格式
 *
 * 实现方式：
 * 1. 使用灵活版本（Tagged Fields）
 * 2. 忽略未知的字段
 */
public class ForwardCompatibility {

    /**
     * 忽略未知字段
     */
    public void parseWithUnknownFields(ByteBuffer buffer) {
        // 解析已知字段
        String topic = readString(buffer);
        byte[] value = readBytes(buffer);

        // 如果有 Tagged Fields，读取并存储
        if (hasTaggedFields(buffer)) {
            List<RawTaggedField> unknownFields = TaggedFields.read(buffer);
            // 存储未知字段，序列化时原样返回
        }
    }

    /**
     * Broker 作为代理时的处理
     */
    public void brokerProxyHandling(Request request) {
        // Broker 收到请求，可能不理解某些字段
        // 策略：透传未知字段到目标节点

        // 解析请求
        ParsedRequest parsed = parse(request);

        // 转发到目标 Broker
        ForwardedRequest forwarded = new ForwardedRequest.Builder()
            .setKnownFields(parsed.knownFields())
            .setUnknownTaggedFields(parsed.unknownTaggedFields())
            .build();
    }
}
```

### 5.3 完整兼容 (Full)

```
完整兼容性要求：

1. 向后兼容（Backward）
   ┌──────────┐              ┌──────────┐
   │ 新客户端 │ ──发送 v2──▶ │ 旧 Broker│  ✓ 支持
   │          │              │          │
   │          │ ◀──响应 v2── │          │  ✓ 支持
   └──────────┘              └──────────┘

2. 向前兼容（Forward）
   ┌──────────┐              ┌──────────┐
   │ 旧客户端 │ ──发送 v0──▶ │ 新 Broker│  ✓ 支持
   │          │              │          │
   │          │ ◀──响应 v0── │          │  ✓ 支持
   └──────────┘              └──────────┘

3. 混合兼容（Full）
   ┌──────────┐              ┌──────────┐
   │ 新客户端 │ ──发送 v2──▶ │ 新 Broker│  ✓ 支持
   │          │              │          │
   │          │ ◀──响应 v2── │          │  ✓ 支持
   └──────────┘              └──────────┘

实现策略：
- 使用灵活版本
- 新增字段必须是可选的
- 为缺失字段提供合理的默认值
```

### 5.4 版本升级策略

```java
/**
 * Kafka 集群升级策略
 */
public class UpgradeStrategy {

    /**
     * 滚动升级流程
     */
    public void rollingUpgrade() {
        // 阶段 1: 升级 Broker（逐个）
        // - 停止一个 Broker
        // - 升级软件
        // - 启动新 Broker
        // - 等待数据同步
        // - 重复直到所有 Broker 升级完成

        // 阶段 2: 升级客户端
        // - 逐步将客户端升级到新版本
        // - 客户端会自动协商新版本
    }

    /**
     * 升级检查清单
     */
    public void upgradeChecklist() {
        // 1. 检查 Broker 间版本差异
        Map<Node, Short> brokerVersions = checkBrokerVersions();

        // 2. 检查客户端版本
        Map<Client, Short> clientVersions = checkClientVersions();

        // 3. 验证功能兼容性
        boolean transactionsSupported = checkFeatureSupport("transactions");
        boolean idempotenceSupported = checkFeatureSupport("idempotence");

        // 4. 监控升级过程
        monitorVersionNegotiation();
        monitorErrorRates();
    }

    /**
     * 降级策略
     */
    public void downgradeStrategy() {
        // 如果升级出现问题：

        // 1. 停止升级过程
        // 2. 回滚已升级的 Broker
        // 3. 回滚客户端（如果需要）
        // 4. 验证回滚后功能正常
    }
}
```

---

**上一章**: [03. Kafka 消息格式演进](./03-message-format.md)
**下一章**: [05. 序列化机制](./05-serialization.md)
