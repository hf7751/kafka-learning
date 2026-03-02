# 09. 故障排查

## 目录
- [1. 副本不一致问题](#1-副本不一致问题)
- [2. ISR 震荡问题](#2-isr-震荡问题)
- [3. Leader 选举失败](#3-leader-选举失败)
- [4. 同步延迟过高](#4-同步延迟过高)
- [5. 数据丢失与恢复](#5-数据丢失与恢复)
- [6. 故障排查工具](#6-故障排查工具)

---

## 1. 副本不一致问题

### 1.1 问题现象

```text
现象:
├── Follower LEO 与 Leader LEO 差距大
├── 数据不一致
└── Consumer 重复消费或数据丢失
```text

### 1.2 排查步骤
```bash
# 1. 检查 ISR 状态
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --describe

# 2. 检查副本 LEO
kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 \
  --topic test \
  --partitions 0

# 3. 检查日志
tail -f /var/log/kafka/server.log | grep -i replica

# 4. 检查网络
ping broker2
iperf -c broker2
```bash

### 1.3 解决方案

```bash
# 方案 1: 重新同步副本
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --execute

# 方案 2: 手动截断
kafka-delete-records.sh \
  --bootstrap-server localhost:9092 \
  --offset-json-file offsets.json

# offsets.json 格式
{
  "partitions": [
    {
      "topic": "test",
      "partition": 0,
      "offset": 100
    }
  ]
}
```

---

## 2. ISR 震荡问题

### 2.1 问题现象

```
现象:
├── ISR 频繁扩展和收缩
├── isr.shrinks.rate 和 isr.expands.rate 高
└── 性能下降
```text

### 2.2 原因分析
```
原因:
1. replica.lag.time.max.ms 设置过小
   └── 网络波动导致频繁移出

2. Follower 性能不足
   └── CPU/磁盘瓶颈

3. 网络不稳定
   └── 延迟/丢包
```properties

### 2.3 解决方案

```properties
# 1. 增加滞后阈值
replica.lag.time.max.ms=60000

# 2. 增加拉取字节
replica.fetch.max.bytes=10485760

# 3. 优化网络
socket.tcp.no.delay=true

# 4. 升级硬件
# 使用 SSD
```

---

## 3. Leader 选举失败

### 3.1 问题现象

```text
现象:
├── 分区无 Leader
├── 读写请求失败
└── 日志显示选举失败
```bash

### 3.2 排查步骤

```bash
# 1. 检查 Controller 状态
kafka-metadata-shell --snapshot <metadata-quorum.properties> \
  --csv-select-record Controller:0

# 2. 检查 Broker 状态
kafka-broker-api-versions.sh \
  --bootstrap-server localhost:9092

# 3. 检查 ISR
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --describe

# 4. 检查配置
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name test \
  --describe
```text

### 3.3 解决方案
```bash
# 方案 1: 手动选举 Leader
kafka-leader-election.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --partition 0 \
  --election-type PREFERRED

# 方案 2: 启用 Unclean 选举 (最后手段)
kafka-configs.sh \
  --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name test \
  --alter \
  --add-config unclean.leader.election.enable=true

# 方案 3: 重启 Controller
```text

---

## 4. 同步延迟过高

### 4.1 问题现象
```
现象:
├── MaxLag 指标高
├── Follower 落后 Leader 很多
└── ISR 收缩
```bash

### 4.2 排查步骤

```bash
# 1. 检查副本延迟
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group group1

# 2. 检查磁盘 I/O
iostat -x 1

# 3. 检查网络
iftop

# 4. 检查 JVM
jstat -gcutil <pid> 1000
```properties

### 4.3 解决方案

```properties
# 1. 增加拉取线程
num.replica.fetchers=2

# 2. 增加拉取字节
replica.fetch.max.bytes=10485760

# 3. 减少等待时间
replica.fetch.wait.max.ms=100

# 4. 启用压缩
compression.type=lz4
```text

---

## 5. 数据丢失与恢复

### 5.1 数据丢失场景
```bash
数据丢失场景:

1. Broker 故障, HW 未持久化
2. Unclean Leader 选举
3. 磁盘故障
4. 误删除
```bash

### 5.2 数据恢复

```bash
# 1. 检查副本状态
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --describe

# 2. 检查日志文件
ls -lh /var/kafka/data/test-0/

# 3. 恢复数据
# 从备份恢复
rsync -av /backup/kafka/test-0/ /var/kafka/data/test-0/

# 4. 重启 Broker
systemctl restart kafka
```text

---

## 6. 故障排查工具

### 6.1 常用工具
```bash
# 1. kafka-topics.sh
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --describe

# 2. kafka-consumer-groups.sh
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --all-groups

# 3. kafka-log-dirs.sh
kafka-log-dirs.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --broker-list 0,1,2

# 4. kafka-metadata-shell
kafka-metadata-shell --snapshot <metadata-quorum.properties> \
  --csv-select-record Partition:test:0
```

---

## 7. 最佳实践

```
故障排查最佳实践:

1. 建立监控告警
   └── 及时发现问题

2. 定期备份
   └── 防止数据丢失

3. 文档化流程
   └-- 快速响应

4. 压力测试
   └── 提前发现问题

5. 定期演练
   └── 熟悉故障处理
```

---

**下一步**: [10. 配置详解](./10-replica-config.md)
