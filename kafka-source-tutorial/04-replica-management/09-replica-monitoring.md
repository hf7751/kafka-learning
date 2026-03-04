# 08. 监控指标

## 目录
- [1. 副本核心指标](#1-副本核心指标)
- [2. ISR 相关指标](#2-isr-相关指标)
- [3. 同步延迟指标](#3-同步延迟指标)
- [4. Leader 选举指标](#4-leader-选举指标)
- [5. 监控告警配置](#5-监控告警配置)

---

## 1. 副本核心指标

### 1.1 LeaderCount

```yaml
# Leader 数量
metric: kafka.server:type=ReplicaManager,name=LeaderCount
描述: 当前 Broker 作为 Leader 的分区数
标签: 无
类型: Gauge
正常值: > 0

告警规则:
- alert: BrokerNoLeader
  expr: kafka_server_replicamanager_leadercount == 0
  for: 5m
  annotations:
    summary: "Broker has no leader partitions"
```yaml

### 1.2 PartitionCount

```yaml
# 分区总数
metric: kafka.server:type=ReplicaManager,name=PartitionCount
描述: 当前 Broker 托管的分区总数
标签: 无
类型: Gauge
正常值: > 0

监控示例:
- alert: LowPartitionCount
  expr: kafka_server_replicamanager_partitioncount < 10
  for: 10m
```yaml

### 1.3 UnderReplicatedPartitions

```yaml
# 复制不足的分区数
metric: kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions
描述: ISR 副本数 < AR 副本数的分区数
标签: 无
类型: Gauge
正常值: 0

告警规则:
- alert: UnderReplicatedPartitions
  expr: kafka_server_replicamanager_underreplicatedpartitions > 0
  for: 5m
  annotations:
    summary: "{{ $value }} partitions are under replicated"
```yaml

---

## 2. ISR 相关指标

### 2.1 ISR 变化速率

```yaml
# ISR 扩展速率
metric: kafka.server:type=ReplicaManager,name=IsrExpandsPerSec
描述: ISR 扩展的速率 (每秒)
类型: Rate

# ISR 收缩速率
metric: kafka.server:type=ReplicaManager,name=IsrShrinksPerSec
描述: ISR 收缩的速率 (每秒)
类型: Rate

告警规则:
- alert: HighISRShrinkRate
  expr: rate(kafka_server_replicamanager_isrshrinkspersec[5m]) > 0.1
  for: 10m
  annotations:
    summary: "ISR shrinking rate is too high"
```

### 2.2 ISR 大小

```yaml
# ISR 平均大小
metric: kafka.cluster:type=Partition,name=IsrSize
描述: ISR 副本数
标签: topic, partition
类型: Gauge

查询示例:
# 平均 ISR 大小
avg(kafka_cluster_partition_isrsize) by (topic)

# ISR 小于配置的分区
kafka_cluster_partition_isrsize < 2
```yaml

---

## 3. 同步延迟指标

### 3.1 副本延迟

```yaml
# 副本 LEO 与 Leader LEO 的差距
metric: kafka.server:type=ReplicaFetcherManager,name=MaxLag
描述: 最大副本延迟 (字节数)
类型: Gauge

告警规则:
- alert: HighReplicaLag
  expr: kafka_server_replicafetchermanager_maxlag > 10000000
  for: 5m
  annotations:
    summary: "Replica lag is {{ $value }} bytes"
```yaml

### 3.2 拉取速率

```yaml
# 拉取请求速率
metric: kafka.server:type=ReplicaFetcherManager,name=RequestsPerSec
描述: 每秒拉取请求数
类型: Rate

# 拉取字节速率
metric: kafka.network:type=RequestMetrics,name=BytesOutPerSec,request=Fetch
描述: 每秒拉取字节数
类型: Rate
```yaml

---

## 4. Leader 选举指标

### 4.1 选举速率

```yaml
# Leader 选举速率
metric: kafka.controller:type=ControllerStats,name=LeaderElectionRateAndTimeMs
描述: Leader 选举速率和平均时间
类型: Rate

告警规则:
- alert: HighLeaderElectionRate
  expr: rate(kafka_controller_controllerstats_leaderelectionrateandtimems[5m]) > 0.1
  for: 10m
  annotations:
    summary: "Leader election rate is too high"
```

---

## 5. 监控告警配置

### 5.1 Prometheus 配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'kafka'
    static_configs:
      - targets: ['localhost:9308']
    scrape_interval: 15s
```bash

### 5.2 Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Kafka Replica Monitoring",
    "panels": [
      {
        "title": "Leader Count",
        "targets": [
          {
            "expr": "kafka_server_replicamanager_leadercount"
          }
        ]
      },
      {
        "title": "Under Replicated Partitions",
        "targets": [
          {
            "expr": "kafka_server_replicamanager_underreplicatedpartitions"
          }
        ]
      },
      {
        "title": "Replica Lag",
        "targets": [
          {
            "expr": "kafka_server_replicafetchermanager_maxlag"
          }
        ]
      }
    ]
  }
}
```

---

**下一步**: [09. 故障排查](./09-replica-troubleshooting.md)
