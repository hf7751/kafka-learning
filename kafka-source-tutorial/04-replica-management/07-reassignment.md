# 07. 分区重分配

## 目录
- [1. 重分配原理](#1-重分配原理)
- [2. 重分配工具使用](#2-重分配工具使用)
- [3. 重分配限制与限流](#3-重分配限制与限流)
- [4. 跨数据中心重分配](#4-跨数据中心重分配)
- [5. 重分配监控与验证](#5-重分配监控与验证)

---

## 1. 重分配原理

### 1.1 重分配概述

```text
分区重分配定义:

目的:
├── 负载均衡
├── 集群扩容/缩容
├── Broker 下线迁移
└── 磁盘故障恢复

影响:
├── 数据迁移
├── Leader 切换
└── 集群性能
```text

### 1.2 重分配流程
```mermaid
graph TB
    Start[开始重分配] --> Generate[生成方案]
    Generate --> Validate[验证方案]
    Validate --> Execute[执行重分配]
    Execute --> Migrate[迁移数据]
    Migrate --> Switch[切换 Leader]
    Switch --> Cleanup[清理旧副本]
    Cleanup --> Verify[验证]
    Verify --> End[完成]

    style Execute fill:#f9f,stroke:#333,stroke-width:4px
```scala

---

## 2. 重分配工具使用

### 2.1 基本操作

```bash
# ========== kafka-reassign-partitions.sh ==========

# 1. 生成重分配方案
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --topics-to-move-json-file topics.json \
  --broker-list "0,1,2,3" \
  --generate

# topics.json 格式
cat > topics.json <<EOF
{
  "topics": [
    {"topic": "test1"},
    {"topic": "test2"}
  ],
  "version": 1
}
EOF

# 2. 执行重分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --execute

# 3. 验证状态
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --verify

# 4. 取消重分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --cancel
```bash

---

## 3. 重分配限制与限流

### 3.1 限流配置

```bash
# 使用 --throttle 参数

kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --execute \
  --throttle 10000000 \  # 10 MB/s
  --timeout 3600000      # 1 hour

# 动态调整限流
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type brokers \
  --entity-name 0 \
  --alter \
  --add-config \
    leader.replication.throttled.rate=10000000,\
    follower.replication.throttled.rate=10000000
```text

---

## 4. 跨数据中心重分配

### 4.1 多机房部署
```text
跨数据中心重分配考虑:

1. 网络延迟
   ├── 影响同步速度
   └── 需要调整超时

2. 带宽成本
   ├── 数据传输量大
   └── 限流非常重要

3. 故障域
   ├── 机房级别故障
   └── 副本分布策略
```bash

### 4.2 机架感知

```properties
# broker.properties
broker.rack=rack1

# 创建 Topic 时指定机架
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --topic test \
  --partitions 6 \
  --replication-factor 3 \
  --config \
    replica.assignment.strategy=org.apache.kafka.common.replica.RackAwareReplicaSelector
```text

---

## 5. 重分配监控与验证

### 5.1 监控指标
```text
重分配监控指标:

1. 重分配进度
   ├── reassigning_partitions
   └── 检查分区数

2. 副本同步延迟
   ├── max_lag
   └── 字节数

3. 限流状态
   ├── throttle_rate
   └── 当前限流值

4. Leader 切换
   ├── leader_count
   └── Leader 分布
```text

### 5.2 验证命令
```bash
# 验证重分配完成
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --verify

# 检查副本状态
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --describe

# 输出示例:
# Topic: test  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3
```

---

## 6. 最佳实践

### 6.1 重分配建议

```
1. 规划阶段
   ├── 评估数据量
   ├── 计算时间
   └── 选择低峰期

2. 执行阶段
   ├── 分批执行
   ├── 监控进度
   └── 准备回滚

3. 验证阶段
   ├── 检查 ISR
   ├── 验证 Leader
   └── 确认数据完整性

4. 清理阶段
   ├── 移除限流
   ├── 删除旧数据
   └── 更新监控
```

---

**下一步**: [08. 监控指标](./08-replica-monitoring.md)
