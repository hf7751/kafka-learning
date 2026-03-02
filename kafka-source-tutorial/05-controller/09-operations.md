# 09. 常用运维操作命令

> **本文档导读**
>
> 本文档整理了 KRaft 模式下的常用运维操作命令，包括元数据查询、Controller 操作和集群管理。
>
> **预计阅读时间**: 30 分钟
>
> **相关文档**:
> - [08-deployment-guide.md](./08-deployment-guide.md) - KRaft 集群部署指南
> - [10-monitoring.md](./10-monitoring.md) - 监控与指标

---

## 1. 元数据查询命令

### 1.1 查看集群元数据

```bash
# 进入元数据 Shell 交互模式
bin/kafka-metadata-shell.sh --snapshot <metadata-log-file>

# 示例
bin/kafka-metadata-shell.sh --snapshot \
  /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/00000000000000000000.snapshot

# 在交互式 Shell 中可执行的命令
>> ls                                    # 列出当前目录
>> cd /brokers                           # 切换到 brokers 目录
>> ls                                    # 列出所有 broker
>> cat /brokers/ids/0                    # 查看 broker 0 的信息
>> cat /topics/test-topic                # 查看 topic 信息
>> exit                                  # 退出
```

### 1.2 查看元数据 Quorum 状态

```bash
# 查看整体状态
bin/kafka-metadata-quorum.sh describe --status

# 输出示例:
# ClusterId:              xxxxx
# LeaderId:               1
# LeaderEpoch:            5
# HighWatermark:          12345
# MaxFollowerLag:         0
# CurrentVoters:          [1,2,3]
# CurrentObservers:       []

# 查看特定分区状态
bin/kafka-metadata-quorum.sh describe \
  --partition \
  --topic test-topic \
  --partition 0

# 输出示例:
# Topic: test-topic
# Partition: 0
# Leader: 1
# LeaderEpoch: 3
# ISR: [1,2,3]
# Replicas: [1,2,3]
```

### 1.3 导出元数据

```bash
# 导出元数据到 JSON 文件
bin/kafka-metadata-shell.sh --snapshot <snapshot-file> --export metadata.json

# 导出特定路径的元数据
bin/kafka-metadata-shell.sh --snapshot <snapshot-file> --export metadata.json \
  --path /topics
```

---

## 2. Controller 操作命令

### 2.1 查看 Controller 信息

```bash
# 查看当前 Controller Leader
bin/kafka-metadata-quorum.sh describe --status | grep LeaderId

# 查看 Controller 集群成员
bin/kafka-metadata-quorum.sh describe --status | grep CurrentVoters

# 查看 Controller 状态详细信息
bin/kafka-metadata-quorum.sh describe --status --bootstrap-server localhost:9092
```

### 2.2 触发 Controller 选举

```bash
# 方法 1: 通过停止 Leader Controller
# 1. 找到 Leader 节点
LEADER_ID=$(bin/kafka-metadata-quorum.sh describe --status | grep LeaderId | awk '{print $2}')

# 2. 停止 Leader 节点
bin/kafka-server-stop.sh

# 3. 观察新 Leader 选举
watch -n 1 'bin/kafka-metadata-quorum.sh describe --status'

# 方法 2: 使用 API 触发选举 (如果有对应工具)
kafka-metadata.sh trigger-leader-election

# 注意: 生产环境慎用，可能导致短暂的服务中断
```

### 2.3 元数据快照操作

```bash
# 查看元数据日志文件
ls -lh /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/

# 输出示例:
# -rw-r--r-- 1 user user  1.2K Jan 01 12:00 00000000000000000000.log
# -rw-r--r-- 1 user user  5.6K Jan 01 12:01 00000000000000000000.snapshot
# -rw-r--r-- 1 user user  2.3K Jan 01 12:02 00000000000000000001.log
# -rw-r--r-- 1 user user    0 Jan 01 12:00 .leader-epoch-checkpoint
# -rw-r--r-- 1 user user   14 Jan 01 12:00 partition.metadata

# 手动触发快照 (如果支持)
kafka-metadata.sh trigger-snapshot --bootstrap-server localhost:9092

# 清理旧快照 (保留最近 N 个)
# 修改配置: metadata.log.max.snapshot.cache.size=3
```

---

## 3. Topic 操作命令

### 3.1 创建和管理 Topic

```bash
# 创建 Topic
bin/kafka-topics.sh --create \
  --topic test-topic \
  --partitions 3 \
  --replication-factor 2 \
  --bootstrap-server localhost:9092

# 查看 Topic 详情
bin/kafka-topics.sh --describe \
  --topic test-topic \
  --bootstrap-server localhost:9092

# 列出所有 Topic
bin/kafka-topics.sh --list \
  --bootstrap-server localhost:9092

# 删除 Topic
bin/kafka-topics.sh --delete \
  --topic test-topic \
  --bootstrap-server localhost:9092
```

### 3.2 修改 Topic 配置

```bash
# 修改分区数
bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --topic test-topic \
  --alter \
  --partitions 6

# 修改 Topic 配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name test-topic \
  --alter \
  --add-config max.message.bytes=1048576

# 查看 Topic 配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name test-topic \
  --describe
```

---

## 4. 集群管理命令

### 4.1 Broker 管理

```bash
# 查看所有 Broker
bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092

# 查看 Broker 配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type brokers \
  --entity-name 0 \
  --describe

# 动态修改 Broker 配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type brokers \
  --entity-name 0 \
  --alter \
  --add-config log.retention.hours=168

# 下线 Broker
# 1. 创建 exclude 文件
echo "0" > /tmp/exclude-brokers.txt

# 2. 执行迁移
bin/kafka-reassign-partitions.sh --bootstrap-server localhost:9092 \
  --topics-to-move-json-file topics-to-move.json \
  --broker-list "1,2,3" \
  --execute

# 3. 验证迁移完成
bin/kafka-reassign-partitions.sh --bootstrap-server localhost:9092 \
  --reassignment-json-file reassign.json \
  --verify
```

### 4.2 集群健康检查

```bash
# 检查集群状态
bin/kafka-cluster.sh --bootstrap-server localhost:9092 \
  --cluster-description

# 检查未同步的分区
bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe \
  --under-replicated-partitions

# 检查不可用的分区
bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe \
  --unavailable-partitions

# 检查 Controller 状态
for broker in broker1:9092 broker2:9092 broker3:9092; do
  echo "Checking $broker:"
  bin/kafka-metadata-quorum.sh describe --status --bootstrap-server $broker
  echo "---"
done
```

---

## 5. 性能分析命令

### 5.1 查看性能指标

```bash
# 查看 JMX 指标
# 1. 启用 JMX 端口
export JMX_PORT=9999
bin/kafka-server-start.sh config/kraft/server.properties &

# 2. 使用 JConsole 或 jstat 查看
jconsole localhost:9999

# 3. 使用命令行查看特定指标
jstat -gc <pid> 1000 10

# 查看 Controller 性能
jconsole localhost:9999
# 导航到: kafka.controller -> QuorumController
# 关注指标:
# - EventQueueSize
# - EventQueueProcessingTime
# - ActiveControllerCount
```

### 5.2 日志分析

```bash
# 查看 Controller 日志
tail -f /tmp/kraft-combined-logs/server.log | grep -i controller

# 统计错误日志
grep -i error /tmp/kraft-combined-logs/server.log | wc -l

# 查看最近的 Leader 选举
grep "became leader" /tmp/kraft-combined-logs/server.log | tail -20

# 分析慢请求
grep "Slow\|took.*ms" /tmp/kraft-combined-logs/server.log | tail -50
```

---

## 6. 故障排查命令

### 6.1 诊断 Controller 问题

```bash
# 检查 Controller 是否正常
# 1. 查看 Leader 是否存在
bin/kafka-metadata-quorum.sh describe --status | grep LeaderId

# 2. 检查 Leader 是否可达
ping $(hostname -I | awk '{print $1}')

# 3. 检查端口是否监听
netstat -tlnp | grep 9093

# 4. 查看 Controller 日志
tail -f /tmp/kraft-combined-logs/server.log | grep -E "Controller|Quorum|Raft"
```

### 6.2 诊断元数据问题

```bash
# 检查元数据日志
# 1. 查看日志文件
ls -lh /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/

# 2. 检查快照完整性
bin/kafka-metadata-shell.sh --snapshot <snapshot-file>

# 3. 查看元数据版本
bin/kafka-metadata-quorum.sh describe --status | grep HighWatermark
```

---

## 7. 日常维护脚本

### 7.1 集群健康检查脚本

```bash
#!/bin/bash
# health-check.sh

BOOTSTRAP_SERVER="localhost:9092"

echo "=== Kafka KRaft 集群健康检查 ==="
echo

# 1. 检查 Controller 状态
echo "1. Controller 状态:"
bin/kafka-metadata-quorum.sh describe --status --bootstrap-server $BOOTSTRAP_SERVER
echo

# 2. 检查离线分区
echo "2. 离线分区:"
bin/kafka-topics.sh --describe --bootstrap-server $BOOTSTRAP_SERVER \
  --unavailable-partitions
echo

# 3. 检查副本不足分区
echo "3. 副本不足的分区:"
bin/kafka-topics.sh --describe --bootstrap-server $BOOTSTRAP_SERVER \
  --under-replicated-partitions
echo

# 4. 检查 Broker 状态
echo "4. Broker 列表:"
bin/kafka-broker-api-versions.sh --bootstrap-server $BOOTSTRAP_SERVER | grep -o 'id: [0-9]*'
echo

echo "=== 检查完成 ==="
```

### 7.2 元数据备份脚本

```bash
#!/bin/bash
# backup-metadata.sh

METADATA_DIR="/tmp/kraft-combined-logs/metadata"
BACKUP_DIR="/backup/kafka-metadata/$(date +%Y%m%d_%H%M%S)"

echo "=== 开始备份元数据 ==="

# 创建备份目录
mkdir -p $BACKUP_DIR

# 复制元数据文件
cp -r $METADATA_DIR/* $BACKUP_DIR/

# 记录集群信息
bin/kafka-metadata-quorum.sh describe --status > $BACKUP_DIR/quorum-status.txt

# 压缩备份
tar -czf $BACKUP_DIR.tar.gz $BACKUP_DIR
rm -rf $BACKUP_DIR

echo "备份完成: $BACKUP_DIR.tar.gz"
```

---

## 8. 常见问题处理

### 8.1 Controller 选举失败

```bash
# 症状: 无法选举出 Leader

# 排查步骤:
# 1. 检查网络连通性
for i in 1 2 3; do
  ping -c 3 controller$i
done

# 2. 检查配置一致性
grep "controller.quorum.voters" config/kraft/server*.properties

# 3. 检查日志
grep -i "election\|quorum" /tmp/kraft-combined-logs/server.log | tail -50

# 4. 强制重启所有 Controller
bin/kafka-server-stop.sh
sleep 10
bin/kafka-server-start.sh -daemon config/kraft/server.properties
```

### 8.2 元数据不一致

```bash
# 症状: 不同节点查询结果不一致

# 排查步骤:
# 1. 检查各个 Controller 的状态
for broker in broker1:9092 broker2:9092 broker3:9092; do
  echo "=== $broker ==="
  bin/kafka-metadata-quorum.sh describe --status --bootstrap-server $broker
done

# 2. 检查 HighWatermark
# 所有节点的 HighWatermark 应该接近

# 3. 查看日志中是否有错误
grep -i "error\|exception" /tmp/kraft-combined-logs/server.log | tail -50
```

---

## 9. 相关文档

- **[08-deployment-guide.md](./08-deployment-guide.md)** - KRaft 集群部署指南
- **[10-monitoring.md](./10-monitoring.md)** - 监控与指标
- **[11-troubleshooting.md](./11-troubleshooting.md)** - 故障排查指南

---

**返回**: [README.md](./README.md)
