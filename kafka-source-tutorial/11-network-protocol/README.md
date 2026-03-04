# 11. Kafka 网络协议详解

本章深入分析 Kafka 自定义网络协议的实现，包括请求/响应格式、版本协商、消息编解码等核心机制。

## 章节目录

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-protocol-overview.md](./01-protocol-overview.md) | 协议概述 | ⭐ |
| [02-request-response-format.md](./02-request-response-format.md) | 请求响应格式 | ⭐⭐ |
| [03-message-format.md](./03-message-format.md) | 消息格式演进 | ⭐⭐⭐ |
| [04-version-negotiation.md](./04-version-negotiation.md) | 版本协商机制 | ⭐⭐ |
| [05-serialization.md](./05-serialization.md) | 序列化机制 | ⭐⭐ |
| [06-network-client.md](./06-network-client.md) | NetworkClient 实现 | ⭐⭐⭐ |
| [07-security-protocol.md](./07-security-protocol.md) | 安全协议 | ⭐⭐ |

## 核心概念速查

### 协议层次
```
┌─────────────────────────────────────────────┐
│              应用层协议                      │
│  - Produce/Fetch/Metadata 等请求             │
├─────────────────────────────────────────────┤
│              消息格式层                      │
│  - RecordBatch / Record                      │
├─────────────────────────────────────────────┤
│              传输层协议                      │
│  - TCP + Kafka 自定义帧格式                  │
└─────────────────────────────────────────────┘
```

### 关键请求类型
| ApiKey | 名称 | 说明 |
|--------|------|------|
| 0 | Produce | 生产消息 |
| 1 | Fetch | 拉取消息 |
| 3 | Metadata | 获取元数据 |
| 8 | OffsetCommit | 提交 Offset |
| 9 | OffsetFetch | 获取 Offset |
| 10 | FindCoordinator | 查找协调器 |
| 11 | JoinGroup | 加入消费组 |
| 14 | SyncGroup | 同步消费组 |

## 学习路径

### 快速了解
1. [协议概述](./01-protocol-overview.md)

### 深入理解
1. [请求响应格式](./02-request-response-format.md)
2. [消息格式](./03-message-format.md)
3. [序列化机制](./05-serialization.md)

### 高级特性
1. [版本协商](./04-version-negotiation.md)
2. [NetworkClient](./06-network-client.md)
3. [安全协议](./07-security-protocol.md)

## 相关章节

- **[02. 请求处理](../02-request-processing/)** - 服务端请求处理
- **[09. Producer](../09-producer/)** - 生产者协议使用
- **[10. Consumer](../10-consumer/)** - 消费者协议使用

---

**上一章**: [10. Consumer 消费者](../10-consumer/README.md)

**教程完结** 🎉
