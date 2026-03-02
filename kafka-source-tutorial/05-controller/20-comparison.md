# 20. KRaft vs ZooKeeper 模式对比

> **本文档导读**
>
> 本文档对比 KRaft 模式和 ZooKeeper 模式的差异。
>
> **预计阅读时间**: 15 分钟
>
> **相关文档**:
> - [01-krft-overview.md](./01-krft-overview.md) - KRaft 架构概述
> - [18-migration-guide.md](./18-migration-guide.md) - ZooKeeper 到 KRaft 迁移指南

---

## 8. 与 ZooKeeper 模式对比

| 特性 | ZooKeeper 模式 | KRaft 模式 |
|------|---------------|-----------|
| **元数据存储** | ZooKeeper | __cluster_metadata Topic |
| **一致性协议** | ZAB | Raft |
| **Controller 数量** | 1 个 (多个候选) | 多个 (Quorum) |
| **元数据延迟** | Watch 通知延迟 | 镜像更新延迟 |
| **部署复杂度** | 需要部署 ZK 集群 | 无需外部依赖 |
| **故障转移** | 需要重新选举 | Raft 自动选举 |
| **扩展性** | 受 ZK 限制 | 更好的水平扩展 |

---
