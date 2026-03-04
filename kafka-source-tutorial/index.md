# Kafka 源码分析教程 - 完整索引

> 📚 深入浅出的 Kafka 3.x 源码分析教程，包含 98+ 个文档，涵盖核心实现机制

---

## 🚀 快速开始

### 新手入门路径
```
1. [架构概览](00-intro/00-architecture-overview.md) → 了解整体设计
2. [源码结构](00-intro/01-source-structure.md) → 熟悉代码组织
3. [调试环境](00-intro/02-build-debug-setup.md) → 搭建开发环境
4. [核心概念](00-intro/03-core-concepts-deep-dive.md) → 理解核心机制
```

### 有经验开发者路径
```
1. [SocketServer 网络层](02-request-processing/01-socketserver.md) → 高并发处理
2. [日志存储机制](03-log-storage/02-log-segment.md) → 高性能存储
3. [副本管理](04-replica-management/03-replica-sync-deep-dive.md) → 可靠性保障
4. [KRaft Controller](05-controller/01-krft-overview.md) → 元数据管理
```

---

## 📖 完整目录

### [00. 入门与架构](00-intro/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [00-architecture-overview.md](00-intro/00-architecture-overview.md) | Kafka 架构概览、KRaft vs ZooKeeper | ⭐ |
| [01-source-structure.md](00-intro/01-source-structure.md) | 源码目录结构、Gradle 构建系统 | ⭐ |
| [02-build-debug-setup.md](00-intro/02-build-debug-setup.md) | 环境搭建、IDE 配置、调试技巧 | ⭐ |
| [03-core-concepts-deep-dive.md](00-intro/03-core-concepts-deep-dive.md) | 核心概念深度解析 | ⭐⭐ |

### [01. 服务启动流程](01-server-startup/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-startup-overview.md](01-server-startup/01-startup-overview.md) | 启动流程概述、入口点分析 | ⭐⭐ |
| [02-kafkaserver-startup.md](01-server-startup/02-kafkaserver-startup.md) | KafkaServer 启动流程详解 | ⭐⭐⭐ |
| [03-startup-config.md](01-server-startup/03-startup-config.md) | 启动配置详解 | ⭐⭐ |

### [02. 请求处理架构](02-request-processing/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-socketserver.md](02-request-processing/01-socketserver.md) | SocketServer 网络层深度解析 | ⭐⭐⭐ |
| [02-request-handler.md](02-request-processing/02-request-handler.md) | KafkaApis 请求处理架构 | ⭐⭐⭐ |

### [03. 日志存储机制](03-log-storage/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-log-overview.md](03-log-storage/01-log-overview.md) | 日志存储架构概述 | ⭐ |
| [02-log-segment.md](03-log-storage/02-log-segment.md) | LogSegment 结构详解 | ⭐⭐ |
| [03-log-index.md](03-log-storage/03-log-index.md) | 日志索引机制 | ⭐⭐ |
| [04-log-append.md](03-log-storage/04-log-append.md) | 日志追加流程 | ⭐⭐⭐ |
| [05-log-read.md](03-log-storage/05-log-read.md) | 日志读取流程、零拷贝 | ⭐⭐⭐ |
| [06-log-cleanup.md](03-log-storage/06-log-cleanup.md) | 日志清理机制 | ⭐⭐ |
| [07-log-compaction.md](03-log-storage/07-log-compaction.md) | 日志压缩详解 | ⭐⭐ |
| [08-log-operations.md](03-log-storage/08-log-operations.md) | 日志操作命令 | ⭐ |
| [09-log-monitoring.md](03-log-storage/09-log-monitoring.md) | 日志监控指标 | ⭐⭐ |
| [10-log-troubleshooting.md](03-log-storage/10-log-troubleshooting.md) | 故障排查指南 | ⭐⭐ |

### [04. 副本管理](04-replica-management/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-replica-overview.md](04-replica-management/01-replica-overview.md) | 副本管理概述 | ⭐ |
| [02-partition-leader.md](04-replica-management/02-partition-leader.md) | 分区 Leader 选举 | ⭐⭐ |
| [03-replica-sync-deep-dive.md](04-replica-management/03-replica-sync-deep-dive.md) | 副本同步深度解析 | ⭐⭐⭐ |
| [04-replica-fetcher.md](04-replica-management/04-replica-fetcher.md) | 副本拉取机制 | ⭐⭐⭐ |
| [05-replica-state.md](04-replica-management/05-replica-state.md) | 副本状态机 | ⭐⭐ |
| [06-replica-sync.md](04-replica-management/06-replica-sync.md) | 副本同步与 ISR | ⭐⭐ |
| [07-replica-operations.md](04-replica-management/07-replica-operations.md) | 副本操作 | ⭐ |
| [08-reassignment.md](04-replica-management/08-reassignment.md) | 分区重分配 | ⭐⭐ |
| [09-replica-monitoring.md](04-replica-management/09-replica-monitoring.md) | 监控指标 | ⭐ |
| [10-replica-troubleshooting.md](04-replica-management/10-replica-troubleshooting.md) | 故障排查 | ⭐⭐ |
| [11-replica-config.md](04-replica-management/11-replica-config.md) | 配置详解 | ⭐ |

### [05. KRaft Controller](05-controller/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-krft-overview.md](05-controller/01-krft-overview.md) | KRaft 架构概述 | ⭐⭐ |
| [01-controller.md](05-controller/01-controller.md) | Controller 控制器详解 | ⭐⭐⭐ |
| [02-startup-flow.md](05-controller/02-startup-flow.md) | 启动流程 | ⭐⭐ |
| [03-quorum-controller.md](05-controller/03-quorum-controller.md) | QuorumController 实现 | ⭐⭐⭐ |
| [04-raft-implementation.md](05-controller/04-raft-implementation.md) | Raft 协议实现 | ⭐⭐⭐ |
| [05-metadata-publishing.md](05-controller/05-metadata-publishing.md) | 元数据发布机制 | ⭐⭐ |
| [06-high-availability.md](05-controller/06-high-availability.md) | 高可用性设计 | ⭐⭐ |
| [07-leader-election.md](05-controller/07-leader-election.md) | Leader 选举 | ⭐⭐ |
| [08-deployment-guide.md](05-controller/08-deployment-guide.md) | 部署指南 | ⭐ |
| [09-operations.md](05-controller/09-operations.md) | 运维操作 | ⭐ |
| [10-monitoring.md](05-controller/10-monitoring.md) | 监控指标 | ⭐ |
| [11-troubleshooting.md](05-controller/11-troubleshooting.md) | 故障排查 | ⭐⭐ |
| [12-configuration.md](05-controller/12-configuration.md) | 配置详解 | ⭐ |
| [13-performance-tuning.md](05-controller/13-performance-tuning.md) | 性能调优 | ⭐⭐ |
| [14-debugging.md](05-controller/14-debugging.md) | 调试技巧 | ⭐⭐ |
| [15-best-practices.md](05-controller/15-best-practices.md) | 最佳实践 | ⭐ |
| [16-security.md](05-controller/16-security.md) | 安全配置 | ⭐⭐ |
| [17-backup-recovery.md](05-controller/17-backup-recovery.md) | 备份恢复 | ⭐⭐ |
| [18-migration-guide.md](05-controller/18-migration-guide.md) | 迁移指南 | ⭐⭐ |
| [19-faq.md](05-controller/19-faq.md) | 常见问题 | ⭐ |
| [20-comparison.md](05-controller/20-comparison.md) | 架构对比 | ⭐ |

### [06. GroupCoordinator 协调器](06-coordinator/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-coordinator-overview.md](06-coordinator/01-coordinator-overview.md) | 协调器概述 | ⭐ |
| [01-group-coordinator.md](06-coordinator/01-group-coordinator.md) | GroupCoordinator 详解 | ⭐⭐⭐ |
| [02-group-management.md](06-coordinator/02-group-management.md) | 消费组管理 | ⭐⭐ |
| [03-rebalance-protocol.md](06-coordinator/03-rebalance-protocol.md) | Rebalance 协议 | ⭐⭐⭐ |
| [04-rebalance-process.md](06-coordinator/04-rebalance-process.md) | Rebalance 流程 | ⭐⭐⭐ |
| [05-offset-management.md](06-coordinator/05-offset-management.md) | Offset 管理 | ⭐⭐ |
| [06-group-state-machine.md](06-coordinator/06-group-state-machine.md) | 消费组状态机 | ⭐⭐ |
| [07-coordinator-operations.md](06-coordinator/07-coordinator-operations.md) | 运维操作 | ⭐ |
| [08-rebalance-optimization.md](06-coordinator/08-rebalance-optimization.md) | Rebalance 优化 | ⭐⭐ |
| [09-coordinator-monitoring.md](06-coordinator/09-coordinator-monitoring.md) | 监控指标 | ⭐ |
| [10-coordinator-troubleshooting.md](06-coordinator/10-coordinator-troubleshooting.md) | 故障排查 | ⭐⭐ |
| [11-coordinator-config.md](06-coordinator/11-coordinator-config.md) | 配置详解 | ⭐ |

### [07. 事务机制](07-transaction/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-transaction-overview.md](07-transaction/01-transaction-overview.md) | 事务概述 | ⭐⭐ |
| [02-transaction-coordinator.md](07-transaction/02-transaction-coordinator.md) | TransactionCoordinator | ⭐⭐⭐ |
| [03-transaction-protocol.md](07-transaction/03-transaction-protocol.md) | 事务协议 | ⭐⭐⭐ |
| [04-two-phase-commit.md](07-transaction/04-two-phase-commit.md) | 两阶段提交 | ⭐⭐⭐ |
| [05-transaction-log.md](07-transaction/05-transaction-log.md) | 事务日志 | ⭐⭐ |
| [06-idempotence.md](07-transaction/06-idempotence.md) | 幂等生产者 | ⭐⭐ |
| [07-transaction-operations.md](07-transaction/07-transaction-operations.md) | 运维操作 | ⭐ |
| [08-transaction-monitoring.md](07-transaction/08-transaction-monitoring.md) | 监控指标 | ⭐ |
| [09-transaction-troubleshooting.md](07-transaction/09-transaction-troubleshooting.md) | 故障排查 | ⭐⭐ |
| [10-transaction-config.md](07-transaction/10-transaction-config.md) | 配置详解 | ⭐ |
| [11-transaction-patterns.md](07-transaction/11-transaction-patterns.md) | 事务模式 | ⭐⭐ |

### [08. 其他](08-other/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [raft-protocol-explained.md](08-other/raft-protocol-explained.md) | Raft 协议通俗指南 | ⭐⭐ |

### [09. Producer 生产者](09-producer/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-producer-overview.md](09-producer/01-producer-overview.md) | Producer 架构概述 | ⭐ |
| [02-record-accumulator.md](09-producer/02-record-accumulator.md) | RecordAccumulator 缓冲区 | ⭐⭐⭐ |
| [03-sender-thread.md](09-producer/03-sender-thread.md) | Sender 线程详解 | ⭐⭐⭐ |
| [04-metadata-management.md](09-producer/04-metadata-management.md) | 元数据管理 | ⭐⭐ |
| [05-partitioner.md](09-producer/05-partitioner.md) | 分区器实现 | ⭐⭐ |
| [06-interceptors.md](09-producer/06-interceptors.md) | 拦截器机制 | ⭐ |
| [07-transaction-manager.md](09-producer/07-transaction-manager.md) | 事务管理器 | ⭐⭐⭐ |
| [08-producer-config.md](09-producer/08-producer-config.md) | 配置详解 | ⭐ |

### [10. Consumer 消费者](10-consumer/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-consumer-overview.md](10-consumer/01-consumer-overview.md) | Consumer 架构概述 | ⭐ |
| [02-fetcher-mechanism.md](10-consumer/02-fetcher-mechanism.md) | Fetcher 拉取机制 | ⭐⭐⭐ |
| [03-consumer-coordinator.md](10-consumer/03-consumer-coordinator.md) | ConsumerCoordinator 消费组协调器 | ⭐⭐⭐ |
| [04-partition-assignor.md](10-consumer/04-partition-assignor.md) | 分区分配策略 | ⭐⭐ |
| [05-rebalance-process.md](10-consumer/05-rebalance-process.md) | Rebalance 重平衡详解 | ⭐⭐⭐ |
| [06-offset-management.md](10-consumer/06-offset-management.md) | Offset 管理策略 | ⭐⭐ |
| [07-new-consumer.md](10-consumer/07-new-consumer.md) | 新版 AsyncKafkaConsumer (3.0+) | ⭐⭐⭐ |
| [08-consumer-config.md](10-consumer/08-consumer-config.md) | 配置详解 | ⭐ |

### [11. 网络协议](11-network-protocol/)

| 文档 | 内容 | 难度 |
|-----|------|------|
| [01-protocol-overview.md](11-network-protocol/01-protocol-overview.md) | 协议概述 | ⭐ |
| [02-request-response-format.md](11-network-protocol/02-request-response-format.md) | 请求响应格式 | ⭐⭐ |
| [03-message-format.md](11-network-protocol/03-message-format.md) | 消息格式演进 | ⭐⭐⭐ |
| [04-version-negotiation.md](11-network-protocol/04-version-negotiation.md) | 版本协商机制 | ⭐⭐ |
| [05-serialization.md](11-network-protocol/05-serialization.md) | 序列化机制 | ⭐⭐ |
| [06-network-client.md](11-network-protocol/06-network-client.md) | NetworkClient 实现 | ⭐⭐⭐ |
| [07-security-protocol.md](11-network-protocol/07-security-protocol.md) | 安全协议 | ⭐⭐ |

---

## 🎯 主题速查

### 按主题查找

#### 网络层
- [SocketServer 架构](02-request-processing/01-socketserver.md)
- [Reactor 线程模型](02-request-processing/01-socketserver.md#reactor-线程模型)
- [Mute/Unmute 流控](02-request-processing/01-socketserver.md#muteunmute-流控机制)

#### 存储层
- [LogSegment 结构](03-log-storage/02-log-segment.md)
- [稀疏索引机制](03-log-storage/03-log-index.md)
- [零拷贝技术](03-log-storage/05-log-read.md)
- [日志清理策略](03-log-storage/06-log-cleanup.md)

#### 副本管理
- [ISR 机制](04-replica-management/06-replica-sync.md)
- [HW 与 LEO](04-replica-management/06-replica-sync.md)
- [Leader 选举](04-replica-management/02-partition-leader.md)
- [副本同步](04-replica-management/04-replica-fetcher.md)

#### KRaft 架构
- [KRaft 概述](05-controller/01-krft-overview.md)
- [Raft 协议](08-other/raft-protocol-explained.md)
- [QuorumController](05-controller/03-quorum-controller.md)
- [元数据管理](05-controller/05-metadata-publishing.md)

#### 消费者组
- [Rebalance 流程](06-coordinator/04-rebalance-process.md)
- [Offset 管理](06-coordinator/05-offset-management.md)
- [分区分配策略](06-coordinator/03-rebalance-protocol.md)

#### 事务
- [两阶段提交](07-transaction/04-two-phase-commit.md)
- [幂等生产者](07-transaction/06-idempotence.md)
- [事务状态机](07-transaction/02-transaction-coordinator.md)

#### Producer
- [架构概述](09-producer/01-producer-overview.md)
- [RecordAccumulator 缓冲区](09-producer/02-record-accumulator.md)
- [Sender 线程](09-producer/03-sender-thread.md)
- [元数据管理](09-producer/04-metadata-management.md)
- [分区器](09-producer/05-partitioner.md)
- [拦截器](09-producer/06-interceptors.md)
- [事务管理器](09-producer/07-transaction-manager.md)
- [配置详解](09-producer/08-producer-config.md)

#### Consumer
- [架构概述](10-consumer/01-consumer-overview.md)
- [Fetcher 拉取机制](10-consumer/02-fetcher-mechanism.md)
- [消费组协调器](10-consumer/03-consumer-coordinator.md)
- [分区分配策略](10-consumer/04-partition-assignor.md)
- [重平衡流程](10-consumer/05-rebalance-process.md)
- [Offset 管理](10-consumer/06-offset-management.md)
- [新版 AsyncKafkaConsumer](10-consumer/07-new-consumer.md)
- [配置详解](10-consumer/08-consumer-config.md)

#### 网络协议
- [协议概述](11-network-protocol/01-protocol-overview.md)
- [请求响应格式](11-network-protocol/02-request-response-format.md)
- [消息格式演进](11-network-protocol/03-message-format.md)
- [版本协商机制](11-network-protocol/04-version-negotiation.md)
- [序列化机制](11-network-protocol/05-serialization.md)
- [NetworkClient](11-network-protocol/06-network-client.md)
- [安全协议](11-network-protocol/07-security-protocol.md)

---

## 📊 统计信息

- **总文档数**: 98+
- **总字数**: 约 190,000+ 字
- **代码示例**: 500+ 段
- **流程图**: 120+ 个
- **章节数**: 11 个
- **Kafka 版本**: 3.7.0+
- **最后更新**: 2026-03-03

---

## 🔗 外部资源

### 官方资源
- [Apache Kafka 官网](https://kafka.apache.org/)
- [Kafka 官方文档](https://kafka.apache.org/documentation/)
- [Kafka GitHub 仓库](https://github.com/apache/kafka)

### 推荐阅读
- [Raft 论文](https://raft.github.io/raft.pdf)
- [Kafka 设计文档](https://kafka.apache.org/documentation/#design)

---

**最后更新**: 2026-03-03

**维护者**: Kafka 源码学习社区
