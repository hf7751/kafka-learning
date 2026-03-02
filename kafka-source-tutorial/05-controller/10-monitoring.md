# 10. 监控与指标

> **本文档导读**
>
> 本文档介绍 KRaft 的监控指标和告警配置。
>
> **预计阅读时间**: 35 分钟
>
> **相关文档**:
> - [11-troubleshooting.md](./11-troubleshooting.md) - 故障排查指南
> - [12-configuration.md](./12-configuration.md) - 配置参数详解

---

## 11. 监控与指标

### 11.1 关键监控指标

#### 11.1.1 JMX 指标

```java
/**
 * Controller 关键 JMX 指标
 *
 * 1. kafka.controller:type=KafkaController,name=ActiveControllerCount
 *    - 活跃 Controller 数量
 *    - 正常值: 1 (只有一个 Leader)
 *
 * 2. kafka.controller:type=KafkaController,name=OfflinePartitionsCount
 *    - 离线分区数量
 *    - 正常值: 0
 *
 * 3. kafka.controller:type=ControllerEventManager,name=EventQueueTimeMs
 *    - 事件队列处理时间
 *    - 监控是否有事件处理延迟
 *
 * 4. kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions
 *    - 副本不足的分区数
 *    - 正常值: 0
 *
 * 5. kafka.controller:type=KafkaController,name=PreferredReplicaImbalanceCount
 *    - 首选副本不平衡数量
 */
```

#### 11.1.2 Raft 协议指标

```java
/**
 * Raft 协议相关指标
 *
 * 1. kafka.raft:type=RaftManager,name=CommitLatencyMs
 *    - 日志提交延迟
 *    - 正常值: < 100ms
 *
 * 2. kafka.raft:type=RaftManager,name=AppendLatencyMs
 *    - 日志追加延迟
 *    - 正常值: < 50ms
 *
 * 3. kafka.raft:type=RaftManager,name=SnapshotLatencyMs
 *    - 快照生成延迟
 *    - 正常值: < 5s
 *
 * 4. kafka.raft:type=RaftManager,name=CurrentState
 *    - 当前节点状态 (Leader/Follower/Candidate)
 *
 * 5. kafka.raft:type=RaftManager,name=CurrentLeader
 *    - 当前 Leader ID
 */
```

### 11.2 Prometheus 监控配置

```yaml
# ==================== Prometheus 配置示例 ====================
# prometheus.yml

global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'kafka-controller'
    static_configs:
      - targets: ['localhost:9092']
    metrics_path: '/metrics'
    # JMX Exporter 配置

# ==================== Grafana Dashboard ====================
# 推荐的 Dashboard 面板:

# 面板 1: Controller 健康状态
# - ActiveControllerCount (Gauge)
# - OfflinePartitionsCount (Gauge)

# 面板 2: Raft 协议指标
# - Leader 选举次数
# - 日志复制延迟
# - 快照生成时间

# 面板 3: 元数据操作
# - CreateTopics 速率
# - DeleteTopics 速率
# - AlterPartitions 速率
```

### 11.3 告警规则

```yaml
# ==================== 告警规则 ====================
groups:
  - name: kafka_controller
    rules:
      # Controller 数量异常
      - alert: KafkaControllerCount
        expr: kafka_controller_KafkaController_ActiveControllerCount != 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Controller 数量异常"
          description: "活跃 Controller 数量不为 1: {{ $value }}"

      # 离线分区
      - alert: KafkaOfflinePartitions
        expr: kafka_controller_KafkaController_OfflinePartitionsCount > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "存在离线分区"
          description: "{{ $value }} 个分区处于离线状态"

      # 日志提交延迟过高
      - alert: KafkaRaftCommitLatency
        expr: kafka_raft_RaftManager_CommitLatencyMs > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Raft 提交延迟过高"
          description: "提交延迟: {{ $value }}ms"

      # 快照生成失败
      - alert: KafkaSnapshotFailure
        expr: rate(kafka_raft_RaftManager_SnapshotFailureCount[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "快照生成失败"
          description: "检测到快照生成失败"
```

---
