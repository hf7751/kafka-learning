# 10. 配置详解

## 目录
- [1. Broker 级别配置](#1-broker-级别配置)
- [2. Topic 级别配置](#2-topic-级别配置)
- [3. 性能调优参数](#3-性能调优参数)
- [4. 可靠性配置](#4-可靠性配置)
- [5. 配置最佳实践](#5-配置最佳实践)

---

## 1. Broker 级别配置

### 1.1 副本管理配置

```properties
# ========== 副本拉取配置 ==========

# 拉取线程数
# 默认: 1
# 推荐: 2
num.replica.fetchers=2

# 单次拉取最大字节数
# 默认: 1048576 (1MB)
# 推荐: 10485760 (10MB)
replica.fetch.max.bytes=10485760

# 最小拉取字节数
# 默认: 1
replica.fetch.min.bytes=1

# 最大等待时间
# 默认: 500 (ms)
replica.fetch.wait.max.ms=500

# 副本滞后时间阈值
# 默认: 30000 (30s)
# 建议不调整
replica.lag.time.max.ms=30000

# 拉取超时时间
# 默认: 120 (s)
replica.fetch.timeout.ms=120
```bash

### 1.2 HW 管理配置

```properties
# ========== HW 检查点配置 ==========

# HW 持久化间隔
# 默认: 5000 (ms)
replica.high.watermark.checkpoint.interval.ms=5000

# 是否在恢复时检查 HW
# 默认: false
replica.checkpoint.interval.ms=0
```properties

### 1.3 Controller 配置

```properties
# ========== Controller 配置 ==========

# Controller 选举超时
# 默认: 1000 (ms)
controller.socket.timeout.ms=30000

# Controller 队列大小
# 默认: 10
controller.quota.window.num=11
```

---

## 2. Topic 级别配置

### 2.1 副本配置

```properties
# ========== Topic 创建时配置 ==========

# 副本因子
# 默认: 1
# 推荐: 3
replication.factor=3

# 最小同步副本数
# 默认: 1
# 推荐: 2
min.insync.replicas=2

# Unclean Leader 选举
# 默认: false
unclean.leader.election.enable=false

# 副本分配策略
# 默认: org.apache.kafka.common.replica.RackAwareReplicaSelector
replica.assignment.class=
```properties

### 2.2 保留配置

```properties
# ========== 数据保留配置 ==========

# 保留时间
# 默认: 604800000 (7天)
retention.ms=604800000

# 保留大小
# 默认: -1 (无限制)
retention.bytes=-1

# 清理策略
# 默认: delete
cleanup.policy=delete
```text

---

## 3. 性能调优参数

### 3.1 网络优化
```properties
# ========== 网络配置 ==========

# Socket 缓冲区
# 默认: 102400 (100KB)
socket.receive.buffer.bytes=102400
socket.send.buffer.bytes=102400

# TCP_NODELAY
# 默认: true
socket.tcp.no.delay=true

# 请求超时
# 默认: 30000 (30s)
request.timeout.ms=30000
```scala

### 3.2 磁盘优化

```properties
# ========== 磁盘配置 ==========

# 日志段大小
# 默认: 1073741824 (1GB)
log.segment.bytes=1073741824

# Flush 间隔
# 默认: Long.MaxValue
log.flush.interval.messages=Long.MaxValue
log.flush.interval.ms=Long.MaxValue

# 日志保留
# 默认: 168 (小时)
log.retention.hours=168
```properties

---

## 4. 可靠性配置

### 4.1 数据可靠性

```properties
# ========== 可靠性配置 ==========

# 消息确认级别
# 默认: 1
# 推荐: all
acks=all

# 启用幂等性
# 默认: false
# 推荐: true
enable.idempotence=true

# 最大请求大小
# 默认: 1048576 (1MB)
message.max.bytes=1048576
```text

### 4.2 高可用配置
```properties
# ========== 高可用配置 ==========

# 最小 ISR
# 默认: 1
min.insync.replicas=2

# Unclean 选举
# 默认: false
unclean.leader.election.enable=false

# 自动 Leader 重新平衡
# 默认: false
auto.leader.rebalance.enable=false
```properties

---

## 5. 配置最佳实践

### 5.1 生产环境配置

```properties
# ========== 生产环境推荐配置 ==========

# 副本配置
num.replica.fetchers=2
replica.fetch.max.bytes=10485760
replica.lag.time.max.ms=30000

# 可靠性配置
min.insync.replicas=2
unclean.leader.election.enable=false
acks=all

# 性能配置
compression.type=lz4
socket.tcp.no.delay=true

# 监控配置
log.retention.hours=168
log.segment.bytes=1073741824
```text

### 5.2 测试环境配置
```properties
# ========== 测试环境配置 ==========

# 减少副本
replication.factor=1

# 减少保留
log.retention.hours=24

# 允许 Unclean 选举
unclean.leader.election.enable=true

# 减少 HW 检查点频率
replica.high.watermark.checkpoint.interval.ms=60000
```bash

### 5.3 配置检查清单

```
配置检查清单:

1. 副本数 >= 3
2. min.insync.replicas >= 2
3. unclean.leader.election.enable = false
4. acks = all
5. num.replica.fetchers >= 2
6. replica.fetch.max.bytes >= 10MB
7. replica.lag.time.max.ms = 30000
8. 压缩启用
9. TCP_NODELAY 启用
10. 监控配置完整
```

---

## 6. 总结

### 6.1 配置要点

| 配置 | 默认值 | 推荐值 | 说明 |
|-----|-------|-------|------|
| `replica.lag.time.max.ms` | 30000 | 30000 | 副本滞后阈值 |
| `num.replica.fetchers` | 1 | 2 | 拉取线程数 |
| `min.insync.replicas` | 1 | 2 | 最小 ISR |
| `unclean.leader.election.enable` | false | false | Unclean 选举 |

---

**返回**: [README](./README.md)
