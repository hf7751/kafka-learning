# 10. Kafka Consumer 消费者详解

本章深入分析 Kafka Consumer 客户端的实现机制，包括消费组管理、分区分配、Offset 管理、Fetch 机制等核心功能。

## 章节目录

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-consumer-overview.md](./01-consumer-overview.md) | Consumer 架构概述 | ⭐ |
| [02-fetcher-mechanism.md](./02-fetcher-mechanism.md) | Fetcher 拉取机制 | ⭐⭐⭐ |
| [03-consumer-coordinator.md](./03-consumer-coordinator.md) | ConsumerCoordinator 消费组协调器 | ⭐⭐⭐ |
| [04-partition-assignor.md](./04-partition-assignor.md) | 分区分配策略 | ⭐⭐ |
| [05-rebalance-process.md](./05-rebalance-process.md) | Rebalance 重平衡详解 | ⭐⭐⭐ |
| [06-offset-management.md](./06-offset-management.md) | Offset 管理策略 | ⭐⭐ |
| [07-new-consumer.md](./07-new-consumer.md) | 新版 AsyncKafkaConsumer (3.0+) | ⭐⭐⭐ |
| [08-consumer-config.md](./08-consumer-config.md) | 配置详解 | ⭐ |

## 核心概念速查

### Consumer 架构
```
┌─────────────────────────────────────────────┐
│            KafkaConsumer                    │
├─────────────────────────────────────────────┤
│  1. subscribe() → 消费组管理                │
│  2. poll() → Fetcher 拉取消息               │
│  3. commitSync/Async() → Offset 提交        │
└─────────────────────────────────────────────┘
```

### 关键配置
| 配置 | 默认值 | 说明 |
|-----|--------|------|
| `bootstrap.servers` | - | Broker 地址列表 |
| `group.id` | - | 消费组 ID |
| `auto.offset.reset` | latest | 起始消费位置 |
| `enable.auto.commit` | true | 自动提交 Offset |
| `max.poll.records` | 500 | 单次拉取最大记录数 |
| `fetch.min.bytes` | 1 | 最小拉取字节数 |
| `fetch.max.wait.ms` | 500 | 最大等待时间 |
| `session.timeout.ms` | 45000 | 会话超时时间 |
| `heartbeat.interval.ms` | 3000 | 心跳间隔 |

## 学习路径

### 快速了解
1. [架构概述](./01-consumer-overview.md)
2. [配置详解](./08-consumer-config.md)

### 深入理解
1. [Fetcher 拉取机制](./02-fetcher-mechanism.md)
2. [ConsumerCoordinator 消费组协调器](./03-consumer-coordinator.md)
3. [分区分配策略](./04-partition-assignor.md)

### 高级特性
1. [Rebalance 重平衡详解](./05-rebalance-process.md)
2. [Offset 管理策略](./06-offset-management.md)
3. [新版 AsyncKafkaConsumer (3.0+)](./07-new-consumer.md)

## 相关章节

- **[09. Producer 生产者](../09-producer/)** - 生产者客户端
- **[03. 日志存储](../03-log-storage/)** - 消息读取机制
- **[11. 网络协议](../11-network-protocol/)** - Consumer 请求协议

---

**上一章**: [09. Producer 生产者](../09-producer/README.md)
**下一章**: [11. 网络协议](../11-network-protocol/README.md)
