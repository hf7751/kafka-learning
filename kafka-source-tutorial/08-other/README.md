# 08. 其他补充内容

本章包含 Kafka 相关的补充内容，包括分布式一致性协议等。

## 文档目录

| 文档 | 内容 | 难度 |
|-----|------|------|
| [raft-protocol-explained.md](./raft-protocol-explained.md) | Raft 协议通俗指南 | ⭐⭐ |

## Raft 协议通俗指南

如果你想深入理解 Kafka KRaft 架构背后的 Raft 协议，强烈推荐阅读：

- **[Raft 协议通俗指南](./raft-protocol-explained.md)**
  - 用通俗易懂的方式解释 Raft 协议
  - 包含大量类比和图示
  - 适合初学者理解分布式一致性
  - 涵盖选举、日志复制、安全性等核心概念

> 💡 这个文档独立于 Kafka 教程，可以帮助你更好地理解 KRaft 的底层原理。

## 相关章节

- **[05. KRaft Controller](../05-controller/)** - KRaft 架构实现
- **[09. Producer 生产者](../09-producer/)** - 生产者客户端

---

**上一章**: [07. 事务机制](../07-transaction/README.md)
**下一章**: [09. Producer 生产者](../09-producer/README.md)
