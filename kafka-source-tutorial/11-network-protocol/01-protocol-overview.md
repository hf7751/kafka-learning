# 01. Kafka 网络协议概述

本文档介绍 Kafka 自定义网络协议的整体架构和设计思想。

## 目录
- [1. 协议设计原则](#1-协议设计原则)
- [2. 协议层次结构](#2-协议层次结构)
- [3. 请求响应模型](#3-请求响应模型)
- [4. 版本兼容性](#4-版本兼容性)

---

## 1. 协议设计原则

### 1.1 设计目标

Kafka 协议设计遵循以下原则：

| 原则 | 说明 |
|------|------|
| **简单高效** | 二进制协议，紧凑高效，易于解析 |
| **版本兼容** | 支持协议版本协商，向后兼容 |
| **可扩展** | 新功能通过新增 API 或版本实现 |
| **通用性** | 统一的请求/响应格式 |

### 1.2 与 HTTP 协议对比

| 特性 | Kafka 协议 | HTTP/REST |
|------|-----------|-----------|
| 传输格式 | 二进制 | 文本 |
| 性能 | 高（无解析开销） | 中 |
| 可读性 | 低 | 高 |
| 灵活性 | 中 | 高 |
| 适用场景 | 内部通信 | 外部接口 |

---

## 2. 协议层次结构

### 2.1 协议栈

```
┌─────────────────────────────────────────────┐
│           应用层 (Application)               │
│  - ProduceRequest/FetchRequest/MetadataRequest│
├─────────────────────────────────────────────┤
│           消息层 (Message)                   │
│  - RecordBatch / Record                      │
│  - 消息格式 v0/v1/v2                         │
├─────────────────────────────────────────────┤
│           传输层 (Transport)                 │
│  - Request/Response 帧格式                   │
│  - TCP 长连接                                │
└─────────────────────────────────────────────┘
```

### 2.2 传输层协议

Kafka 使用 TCP 作为传输层协议：

```
┌──────────┐                      ┌──────────┐
│ Client   │ ─────── TCP ──────── │  Broker  │
│          │ ◄────── 长连接 ────── │          │
└──────────┘                      └──────────┘
```

**特点**:
- 长连接，减少连接建立开销
- 客户端维护连接池
- Broker 端单端口多协议

---

## 3. 请求响应模型

### 3.1 基本通信模型

```
Client                                    Server
   │                                         │
   │ ┌─────────────────────────────────────┐ │
   │ │ Request Header                      │ │
   │ │ - api_key (2 bytes)                 │ │
   │ │ - api_version (2 bytes)             │ │
   │ │ - correlation_id (4 bytes)          │ │
   │ │ - client_id (string)                │ │
   │ └─────────────────────────────────────┘ │
   │ ┌─────────────────────────────────────┐ │
   │ │ Request Body                        │ │
   │ │ - API 特定字段                       │ │
   │ └─────────────────────────────────────┘ │
   │────────────────────────────────────────▶│
   │                                         │
   │         ┌──────────────────────┐        │
   │ ◀────── │ Response Header      │        │
   │         │ - correlation_id     │        │
   │         └──────────────────────┘        │
   │         ┌──────────────────────┐        │
   │ ◀────── │ Response Body        │        │
   │         │ - API 特定响应       │        │
   │         └──────────────────────┘        │
```

### 3.2 Correlation ID

```java
/**
 * 用于匹配请求和响应
 */
int correlationId = 0;

// 发送请求时
RequestHeader header = new RequestHeader(apiKey, apiVersion, correlationId++, clientId);

// 收到响应时
ResponseHeader responseHeader = parseResponseHeader();
assert responseHeader.correlationId == expectedCorrelationId;
```

### 3.3 主要 API Keys

| ApiKey | 名称 | 说明 |
|--------|------|------|
| 0 | Produce | 生产消息 |
| 1 | Fetch | 拉取消息 |
| 2 | ListOffsets | 列出 Offset 范围 |
| 3 | Metadata | 获取集群元数据 |
| 8 | OffsetCommit | 提交消费进度 |
| 9 | OffsetFetch | 获取消费进度 |
| 10 | FindCoordinator | 查找协调器 |
| 11 | JoinGroup | 加入消费组 |
| 12 | Heartbeat | 心跳 |
| 13 | LeaveGroup | 离开消费组 |
| 14 | SyncGroup | 同步消费组 |
| 15 | DescribeGroups | 描述消费组 |
| 16 | ListGroups | 列出消费组 |
| 17 | SaslHandshake | SASL 握手 |
| 18 | ApiVersions | 获取支持的 API 版本 |
| 20 | DeleteRecords | 删除记录 |
| 21 | InitProducerId | 初始化生产者 ID |
| 22 | OffsetForLeaderEpoch | Leader Epoch 信息 |
| 24 | AddPartitionsToTxn | 添加分区到事务 |
| 25 | AddOffsetsToTxn | 添加 Offset 到事务 |
| 26 | EndTxn | 结束事务 |
| 27 | WriteTxnMarkers | 写入事务标记 |

---

## 4. 版本兼容性

### 4.1 版本协商流程

```
Client                              Broker
   │                                   │
   │ ───────── ApiVersions ─────────▶ │
   │                                   │
   │ ◀──────── 支持的版本列表 ──────── │
   │                                   │
   │ ─────── 后续请求使用协商版本 ────▶ │
```

### 4.2 版本升级策略

```scala
/**
 * 向后兼容原则：
 * 1. 新版本可以处理旧版本请求
 * 2. 新增字段为可选
 * 3. 不修改已有字段含义
 */

// 版本变更示例
// v0: 基础版本
case class RequestV0(field1: String, field2: Int)

// v1: 新增可选字段 field3
case class RequestV1(field1: String, field2: Int, field3: Option[String] = None)

// v2: 新增字段，有默认值
case class RequestV2(field1: String, field2: Int, field3: Option[String] = None,
                     field4: Long = 0L)
```

### 4.3 灵活版本 (Flexible Versions)

Kafka 2.4+ 引入灵活版本：

| 特性 | 说明 |
|------|------|
|  tagged fields | 带标签的可选字段 |
|  扩展性 | 无需新增版本即可添加字段 |
|  兼容性 | 更好的向前兼容 |

---

## 5. 与客户端的关系

### 5.1 Producer 使用的协议

```
ApiVersions (版本协商)
   ↓
Metadata (获取元数据)
   ↓
InitProducerId (幂等性/事务)
   ↓
Produce (循环发送消息)
   ↓
AddPartitionsToTxn (事务)
AddOffsetsToTxn (事务)
EndTxn (事务)
```

### 5.2 Consumer 使用的协议

```
ApiVersions (版本协商)
   ↓
Metadata (获取元数据)
   ↓
FindCoordinator (查找协调器)
   ↓
JoinGroup (加入消费组)
SyncGroup (同步分配)
   ↓
Fetch (循环拉取消息)
   ↓
OffsetCommit (提交进度)
   ↓
Heartbeat (维持成员身份)
```

---

**下一章**: [02. 请求响应格式详解](./02-request-response-format.md)
