# 04. 副本管理与同步机制

本章节深入剖析 Kafka 副本管理的核心机制，包括 ISR 动态调整、Leader 选举、副本同步、HW 管理等关键设计。

## 章节目录

### 核心文档

- **[01. 副本管理概述](./01-replica-overview.md)**
  - 副本角色与职责
  - ReplicaManager 架构
  - 副本生命周期
  - 核心数据结构

- **[02. 分区 Leader 选举](./02-partition-leader.md)**
  - Leader 选举触发条件
  - 选举算法与流程
  - Unclean Leader 选举
  - Leader Epoch 机制
  - 选举实战案例

- **[03. 副本拉取机制](./03-replica-fetcher.md)**
  - ReplicaFetcherThread 架构
  - 拉取请求构建
  - 副本同步流程
  - 拉取性能优化
  - 故障处理与重试

- **[04. 副本状态机](./04-replica-state.md)**
  - 副本状态定义
  - 状态转换规则
  - Online/Offline 状态
  - 状态持久化与恢复

- **[05. 副本同步与 ISR](./05-replica-sync.md)**
  - ISR 机制详解
  - LEO 与 HW 管理
  - ISR 扩展与收缩
  - 数据一致性保障
  - 同步性能调优

- **[06. 副本操作](./06-replica-operations.md)**
  - 副本创建与删除
  - 副本增量与减量
  - 跨路径副本迁移
  - 副本下线与上线
  - 操作最佳实践

- **[07. 分区重分配](./07-reassignment.md)**
  - 重分配原理
  - kafka-reassign-partitions.sh 使用
  - 重分配限制与限流
  - 跨数据中心重分配
  - 重分配监控与验证

- **[08. 监控指标](./08-replica-monitoring.md)**
  - 副本核心指标
  - ISR 相关指标
  - 同步延迟指标
  - Leader 选举指标
  - 监控告警配置

- **[09. 故障排查](./09-replica-troubleshooting.md)**
  - 副本不一致问题
  - ISR 震荡问题
  - Leader 选举失败
  - 同步延迟过高
  - 数据丢失与恢复
  - 故障排查工具

- **[10. 配置详解](./10-replica-config.md)**
  - Broker 级别配置
  - Topic 级别配置
  - 性能调优参数
  - 可靠性配置
  - 配置最佳实践

## 学习路径

### 初学者路径
1. 阅读 [01. 副本管理概述](./01-replica-overview.md) 了解基本概念
2. 学习 [05. 副本同步与 ISR](./05-replica-sync.md) 理解同步机制
3. 查看 [10. 配置详解](./10-replica-config.md) 掌握基础配置

### 进阶路径
1. 深入 [02. 分区 Leader 选举](./02-partition-leader.md) 理解选举算法
2. 研究 [03. 副本拉取机制](./03-replica-fetcher.md) 掌握同步细节
3. 实践 [07. 分区重分配](./07-reassignment.md) 运维操作

### 专家路径
1. 精通 [04. 副本状态机](./04-replica-state.md) 源码实现
2. 掌握 [08. 监控指标](./08-replica-monitoring.md) 建立监控体系
3. 研究 [09. 故障排查](./09-replica-troubleshooting.md) 处理复杂问题

## 核心概念速查

### 副本角色
| 角色 | 职责 | 数量 |
|-----|------|------|
| **Leader** | 处理读写请求，管理 ISR | 每分区 1 个 |
| **Follower** | 从 Leader 拉取数据，异步复制 | 每分区 N-1 个 |
| **ISR** | 与 Leader 保持同步的副本集合 | 动态变化 |

### 关键术语
- **LEO (Log End Offset)**: 日志末尾偏移量，下一条待写入消息的位置
- **HW (High Watermark)**: 高水位，ISR 中所有副本都已同步的偏移量
- **ISR (In-Sync Replicas)**: 同步副本集合，参与 Leader 选举
- **OSR (Out-of-Sync Replicas)**: 不同步副本，不参与选举
- **Leader Epoch**: Leader 版本号，用于识别过期 Leader

### 一致性保障
```
已提交消息 = 被 ISR 中所有副本确认的消息
           = offset ≤ HW 的消息

Consumer 可见性: 只读取 offset ≤ HW 的消息
Producer 确认: acks=all 时等待 ISR 确认
```

## 实战场景

### 场景 1: 副本同步延迟
**问题**: Follower 长时间落后 Leader

**排查步骤**:
1. 检查 [监控指标](./08-replica-monitoring.md)
2. 查看 [故障排查文档](./09-replica-troubleshooting.md)
3. 调整 [配置参数](./10-replica-config.md)

### 场景 2: Leader 选举频繁
**问题**: 分区 Leader 频繁切换

**排查步骤**:
1. 查看 [Leader 选举机制](./02-partition-leader.md)
2. 检查 Broker 健康状态
3. 参考 [故障排查](./09-replica-troubleshooting.md)

### 场景 3: 分区重分配
**问题**: 需要平衡集群负载

**操作步骤**:
1. 阅读 [重分配文档](./07-reassignment.md)
2. 生成重分配方案
3. 执行并监控进度

## 相关章节

- **[03. 日志存储](../03-log-storage/)**: 日志段文件管理
- **[05. Controller 控制器](../05-controller/)**: 分区 Leader 选举协调
- **[06. 网络层](../06-network/)**: 请求处理与网络通信
- **[07. 协调器](../07-coordinator/)**: 消费组与事务协调

## 参考资源

### 官方文档
- [Kafka Replication](https://kafka.apache.org/documentation/#replication)
- [Kafka Configuration](https://kafka.apache.org/documentation/#brokerconfigs)

### 源码位置
- `core/src/main/scala/kafka/server/ReplicaManager.scala`
- `core/src/main/scala/kafka/cluster/Partition.scala`
- `core/src/main/scala/kafka/server/ReplicaFetcherThread.scala`

---

**上一章**: [03. 日志存储](../03-log-storage/)
**下一章**: [05. Controller 控制器](../05-controller/)
