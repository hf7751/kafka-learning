# 13. 性能优化技巧

> **本文档导读**
>
> 本文档介绍 KRaft 模式的性能优化技巧，包括元数据性能、吞吐量调优和延迟优化。
>
> **预计阅读时间**: 30 分钟
>
> **相关文档**:
> - [12-configuration.md](./12-configuration.md) - 配置参数详解
> - [14-debugging.md](./14-debugging.md) - 调试技巧

---

## 1. 元数据性能优化

### 1.1 快照生成调优

```properties
# ==================== 快照相关配置 ====================
#
# 快照是元数据的完整备份，用于快速恢复
#

# 快照生成间隔的字节阈值
# 默认: 20000
# 调优: 如果元数据变更频繁，可以增大此值
metadata.log.max.record.bytes.between.snapshots=50000

# 快照保留数量
# 默认: 3
# 调优: 增加可以加快恢复，但占用更多磁盘
metadata.log.max.snapshot.cache.size=5

# 快照最大间隔时间
# 默认: 60s
# 调优: 可以设置为更短时间以获得更实时的快照
metadata.log.max.snapshot.interval.ms=30000
```

**调优建议**:

```java
/**
 * 快照生成策略:
 *
 * 1. 元数据变更频繁的场景
 *    - 增加 bytes.between.snapshots (50000-100000)
 *    - 减少快照生成频率，避免 I/O 压力
 *
 * 2. 元数据变更较少的场景
 *    - 减少 bytes.between.snapshots (10000-20000)
 *    - 更频繁的快照，恢复更快
 *
 * 3. 磁盘 I/O 受限的场景
 *    - 减少快照保留数量 (1-2)
 *    - 增加快照间隔时间 (60s-120s)
 */
```

### 1.2 元数据日志性能

```properties
# ==================== 元数据日志配置 ====================

# 元数据日志目录
# 建议: 使用独立的磁盘，避免与数据日志竞争 I/O
metadata.log.dir=/mnt/ssd/kafka/metadata

# 日志段大小
# 默认: 1073741824 (1GB)
# 调优: 元数据日志通常很小，可以减小
log.segment.bytes=268435456

# 日志刷新间隔
# 默认: 60s
# 调优: 降低可以减少元数据变更延迟，但增加 I/O
log.flush.interval.messages=1000
log.flush.interval.ms=1000
```

---

## 2. Controller 性能优化

### 2.1 事件队列优化

```properties
# ==================== Controller 事件队列 ====================

# Controller 性能采样周期
# 默认: 1000ms
# 调优: 降低可以获得更细粒度的性能数据
controller.performance.sample.period.ms=500

# Controller 性能日志阈值
# 默认: 1000ms
# 调优: 降低可以捕获更多慢操作
controller.performance.always.log.threshold.ms=100
```

**性能监控**:

```bash
# 查看事件队列大小
jconsole localhost:9999
# 导航到: kafka.controller -> QuorumController
# 监控指标:
# - EventQueueSize
# - EventQueueProcessingTimeMs (p50, p95, p99)

# 如果 EventQueueSize 持续增长，说明处理速度跟不上
```

### 2.2 批处理优化

```properties
# ==================== 批处理配置 ====================

# 元数据记录批量大小
# 默认: 根据记录类型动态调整
# 调优: 增加可以提高吞吐量
metadata.log.max.record.bytes.between.snapshots=50000

# Controller 请求超时
# 默认: 30000ms
# 调优: 根据网络延迟调整
controller.quorum.request.timeout.ms=10000
```

---

## 3. Raft 协议性能

### 3.1 选举和心跳调优

```properties
# ==================== Raft 选举参数 ====================

# 选举超时
# 默认: 1000ms
# 调优:
#   - 网络好: 500-1000ms
#   - 网络差: 2000-5000ms
controller.quorum.election.timeout.ms=1000

# 心跳间隔
# 默认: 100ms
# 调优: election.timeout.ms 的 1/10
controller.quorum.heartbeat.interval.ms=100

# 日志拉取超时
# 默认: 2000ms
# 调优: heartbeat.interval.ms 的 10-20 倍
controller.quorum.fetch.timeout.ms=2000
```

**调优建议**:

```java
/**
 * Raft 性能调优策略:
 *
 * 1. 低延迟优先
 *    - 降低选举超时 (500ms)
 *    - 降低心跳间隔 (50ms)
 *    - 增加网络开销
 *
 * 2. 稳定性优先
 *    - 增加选举超时 (2000ms)
 *    - 增加心跳间隔 (200ms)
 *    - 减少网络开销
 *
 * 3. 平衡配置 (推荐)
 *    - 选举超时: 1000ms
 *    - 心跳间隔: 100ms
 *    - 拉取超时: 2000ms
 */
```

### 3.2 日志复制优化

```properties
# ==================== 日志复制配置 ====================

# 复制拉取最大字节数
# 默认: 根据可用内存动态调整
# 调优: 增加可以提高复制速度
controller.quorum.fetch.max.wait.ms=100

# 复制拉取最小字节数
# 默认: 1
# 调优: 增加可以减少拉取次数
controller.quorum.fetch.min.bytes=1024
```

---

## 4. 元数据发布优化

### 4.1 Publisher 性能

```scala
/**
 * MetadataPublisher 性能优化:
 *
 * 1. 异步发布
 *    - 所有 Publisher 都是异步更新
 *    - 不会阻塞 Controller 主线程
 *
 * 2. 增量更新
 *    - 只发送变更的部分
 *    - 减少网络传输
 *
 * 3. 批量通知
 *    - 多个变更批量发送
 *    - 减少通知次数
 */
```

### 4.2 Broker 元数据同步

```properties
# ==================== Broker 元数据同步 ====================

# 元数据刷新间隔
# 默认: 100ms
# 调优: 降低可以更快获取最新元数据
metadata.refresh.interval.ms=50

# 元数据快照缓存大小
# 默认: 5
# 调优: 增加可以减少重新加载
metadata.max.idle.interval.ms=300000
```

---

## 5. 网络性能优化

### 5.1 网络缓冲区

```properties
# ==================== 网络配置 ====================

# 发送缓冲区大小
# 默认: 131072 (128KB)
# 调优: 增加可以提高吞吐量
socket.send.buffer.bytes=262144

# 接收缓冲区大小
# 默认: 131072 (128KB)
# 调优: 增加可以提高吞吐量
socket.receive.buffer.bytes=262144

# 请求最大字节数
# 默认: 104857600 (100MB)
# 调优: 根据元数据大小调整
socket.request.max.bytes=104857600
```

### 5.2 连接池配置

```properties
# ==================== 连接配置 ====================

# 最大连接数
# 默认: 根据处理器数量
# 调优: 增加可以支持更多并发连接
max.connections=10000

# 连接最大空闲时间
# 默认: 600000ms (10分钟)
# 调优: 降低可以更快回收连接
connections.max.idle.ms=300000
```

---

## 6. JVM 调优

### 6.1 堆内存配置

```bash
# Controller 节点 JVM 参数

# 堆内存大小 (根据元数据大小调整)
export KAFKA_HEAP_OPTS="-Xms2g -Xmx2g"

# 年轻代大小
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:NewSize=512m -XX:MaxNewSize=512m"

# GC 算法 (G1GC)
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:+UseG1GC"

# GC 日志
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:+PrintGCDetails -XX:+PrintGCDateStamps"
```

### 6.2 GC 调优

```bash
# G1GC 参数

# 目标停顿时间
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:MaxGCPauseMillis=200"

# 并行 GC 线程数
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:ParallelGCThreads=8"

# 并发 GC 线程数
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:ConcGCThreads=2"

# 保留内存映射
export KAFKA_HEAP_OPTS="$KAFKA_HEAP_OPTS -XX:MaxDirectMemorySize=1G"
```

---

## 7. 磁盘 I/O 优化

### 7.1 磁盘选择

```scala
/**
 * 磁盘配置建议:
 *
 * 1. 元数据日志
 *    - 使用 SSD (优先)
 *    - 独立磁盘 (避免与数据日志竞争)
 *    - RAID 10 (高可用)
 *
 * 2. 数据日志
 *    - 使用 HDD 或 SSD
 *    - 多个磁盘并行
 *    - JBOD 或 RAID 10
 *
 * 3. 日志目录配置
 *    log.dirs=/mnt/ssd1/kafka,/mnt/ssd2/kafka,/mnt/hdd1/kafka
 */
```

### 7.2 I/O 调度

```bash
# SSD: 使用 noop 调度器
echo noop > /sys/block/sda/queue/scheduler

# HDD: 使用 deadline 调度器
echo deadline > /sys/block/sdb/queue/scheduler

# NVMe: 使用 none 调度器
echo none > /sys/block/nvme0n1/queue/scheduler
```

---

## 8. 操作系统调优

### 8.1 文件描述符

```bash
# /etc/security/limits.conf

kafka soft nofile 100000
kafka hard nofile 100000

# 验证
ulimit -n
```

### 8.2 网络参数

```bash
# /etc/sysctl.conf

# TCP keepalive
net.ipv4.tcp_keepalive_time=600
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=3

# TCP 缓冲区
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 65536 16777216

# 应用配置
sysctl -p
```

---

## 9. 性能测试

### 9.1 元数据性能测试

```bash
# 测试元数据创建性能
bin/kafka-topics.sh --create --topic test-1 --partitions 10 --replication-factor 3 --bootstrap-server localhost:9092
bin/kafka-topics.sh --create --topic test-2 --partitions 10 --replication-factor 3 --bootstrap-server localhost:9092
# ... 创建更多 Topic

# 测量延迟
time bin/kafka-topics.sh --create --topic test-latency --partitions 100 --replication-factor 3 --bootstrap-server localhost:9092

# 查看指标
jconsole localhost:9999
# 监控: kafka.controller -> QuorumController -> EventQueueProcessingTimeMs
```

### 9.2 基准测试

```bash
# 使用 kafka-perf-test 测试

# 测试元数据变更吞吐量
for i in {1..1000}; do
  bin/kafka-topics.sh --create --topic perf-test-$i --partitions 10 --replication-factor 3 --bootstrap-server localhost:9092 &
done

# 统计完成时间
time wait

# 检查错误
grep -i error /tmp/kraft-combined-logs/server.log | wc -l
```

---

## 10. 性能监控

### 10.1 关键指标

```java
/**
 * 关键性能指标:
 *
 * 1. Controller 指标
 *    - EventQueueProcessingTimeMs (p50, p95, p99)
 *    - ActiveControllerCount
 *    - OfflinePartitionsCount
 *
 * 2. Raft 指标
 *    - CommitLatencyMs
 *    - AppendLatencyMs
 *    - SnapshotLatencyMs
 *
 * 3. 元数据指标
 *    - MetadataVersion
 *    - HighWatermark
 *    - NumberOfPartitions
 */
```

### 10.2 告警阈值

```yaml
# Prometheus 告警规则

groups:
  - name: kafka_controller_performance
    rules:
      # 事件处理延迟过高
      - alert: ControllerEventQueueSlow
        expr: histogram_quantile(0.95, kafka_controller_quorumcontroller_EventQueueProcessingTimeMs) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Controller 事件处理延迟过高"

      # Raft 提交延迟过高
      - alert: RaftCommitSlow
        expr: kafka_raft_RaftManager_CommitLatencyMs_p95 > 500
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Raft 日志提交延迟过高"
```

---

## 11. 相关文档

- **[12-configuration.md](./12-configuration.md)** - 配置参数详解
- **[10-monitoring.md](./10-monitoring.md)** - 监控与指标
- **[14-debugging.md](./14-debugging.md)** - 调试技巧

---

**返回**: [README.md](./README.md)
