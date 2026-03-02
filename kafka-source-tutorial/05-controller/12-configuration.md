# 12. 配置参数详解

> **本文档导读**
>
> 本文档详细解释 KRaft 相关的配置参数。
>
> **预计阅读时间**: 40 分钟
>
> **相关文档**:
> - [13-performance-tuning.md](./13-performance-tuning.md) - 性能优化技巧
> - [08-deployment-guide.md](./08-deployment-guide.md) - KRaft 集群部署指南

---

## 13. 配置参数详解

### 13.1 核心配置参数

| 参数 | 默认值 | 说明 | 推荐值 |
|------|--------|------|--------|
| **process.roles** | - | 节点角色 (broker/controller) | 根据部署模式 |
| **node.id** | - | 节点唯一标识 | 0-1000 |
| **controller.quorum.voters** | - | Controller 集群成员 | 3-5 个节点 |
| **listeners** | - | 监听地址列表 | 配置实际地址 |
| **controller.quorum.election.timeout.ms** | 1000 | 选举超时时间 | 1000-5000 |
| **controller.quorum.heartbeat.interval.ms** | 500 | 心跳间隔 | 100-500 |
| **metadata.log.max.record.bytes.between.snapshots** | 20000 | 快照触发阈值 | 根据负载调整 |

### 13.2 性能调优参数

```properties
# ==================== 吞吐量优化 ====================
# 增加批量写入
metadata.log.max.batch.size=10000

# 减少 ACK 等待
controller.quorum.request.timeout.ms=2000

# 并行复制
num.replica.alter.log.dirs.threads=4

# ==================== 延迟优化 ====================
# 减少批量大小
metadata.log.max.batch.size=1000

# 减少快照间隔
metadata.log.max.snapshot.interval.bytes=10485760

# ==================== 可靠性优化 ====================
# 增加副本数 (仅 Controller)
controller.quorum.voters=1@host1:9093,2@host2:9093,3@host3:9093

# 增加快照保留
metadata.log.max.snapshot.cache.size=5

# 启用日志压缩
log.cleanup.policy=compact
```

### 13.3 不同场景的配置推荐

```properties
# ==================== 开发环境 ====================
# 单节点开发
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@localhost:9093
listeners=PLAINTEXT://:9092,CONTROLLER://:9093

# 快速测试
metadata.log.max.record.bytes.between.snapshots=1000
controller.quorum.election.timeout.ms=500

# ==================== 测试环境 ====================
# 3 节点集群
process.roles=broker,controller
controller.quorum.voters=1@test1:9093,2@test2:9093,3@test3:9093

# 平衡性能和可靠性
metadata.log.max.record.bytes.between.snapshots=20000
controller.quorum.election.timeout.ms=1000

# ==================== 生产环境 ====================
# 分离 Broker 和 Controller
# Broker 配置
process.roles=broker
node.id=1
listeners=PLAINTEXT://:9092
controller.quorum.voters=1@ctrl1:9093,2@ctrl2:9093,3@ctrl3:9093

# Controller 配置
process.roles=controller
node.id=1
listeners=CONTROLLER://:9093
controller.quorum.voters=1@ctrl1:9093,2@ctrl2:9093,3@ctrl3:9093

# 高可靠性配置
metadata.log.max.record.bytes.between.snapshots=50000
metadata.log.max.snapshot.interval.bytes=52428800
controller.quorum.election.timeout.ms=2000
```

---
