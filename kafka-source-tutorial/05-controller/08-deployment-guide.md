# 08. KRaft 集群部署指南

> **本文档导读**
>
> 本文档提供 KRaft 集群的完整部署指南，包括准备工作、配置步骤和验证方法。
>
> **预计阅读时间**: 40 分钟
>
> **相关文档**:
> - [12-configuration.md](./12-configuration.md) - 配置参数详解
> - [09-operations.md](./09-operations.md) - 常用运维操作命令

---

## 10. 实战操作指南

### 10.1 搭建 KRaft 集群

#### 10.1.1 准备工作

```bash
# 1. 下载 Kafka
wget https://downloads.apache.org/kafka/3.7.0/kafka_2.13-3.7.0.tgz
tar -xzf kafka_2.13-3.7.0.tgz
cd kafka_2.13-3.7.0

# 2. 生成集群 ID
KAFKA_CLUSTER_ID="$(bin/kafka-storage.sh random-uuid)"
echo "Cluster ID: $KAFKA_CLUSTER_ID"

# 3. 格式化存储目录 (每个节点都需要执行)
# Node 1
bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server.properties \
  --ignore-formatted

# Node 2 (如果有多节点)
bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server-2.properties \
  --ignore-formatted
```

#### 10.1.2 配置文件详解

```properties
# ==================== 基础配置 ====================
# 进程角色：同时作为 Broker 和 Controller
process.roles=broker,controller

# 节点 ID
node.id=1

# Controller 监听地址
controller.listener.names=CONTROLLER

# 监听器配置
listeners=PLAINTEXT://:9092,CONTROLLER://:9093

# 广播地址 (集群环境需要配置实际 IP)
advertised.listeners=PLAINTEXT://localhost:9092

# Controller 集群成员列表
controller.quorum.voters=1@localhost:9093,2@localhost:9094,3@localhost:9095

# ==================== 日志配置 ====================
# 日志目录
log.dirs=/tmp/kraft-combined-logs

# ==================== 元数据配置 ====================
# 元数据日志目录
metadata.log.dir=/tmp/kraft-combined-logs/metadata

# 快照生成频率
metadata.log.max.snapshot.interval.bytes=52428800

# ==================== Raft 配置 ====================
# 选举超时 (ms)
controller.quorum.election.timeout.ms=1000

# 心跳间隔 (ms)
controller.quorum.heartbeat.interval.ms=500

# 请求超时 (ms)
controller.quorum.request.timeout.ms=2000

# ==================== 性能调优 ====================
# 批量写入大小
metadata.log.max.record.bytes.between.snapshots=20000

# 快照保留数量
metadata.log.max.snapshot.cache.size=3
```

#### 10.1.3 启动集群

```bash
# 1. 启动 Controller 节点 (先启动所有 Controller)
# Node 1
bin/kafka-server-start.sh -daemon config/kraft/server.properties

# Node 2
bin/kafka-server-start.sh -daemon config/kraft/server-2.properties

# Node 3
bin/kafka-server-start.sh -daemon config/kraft/server-3.properties

# 2. 验证集群状态
bin/kafka-metadata-shell.sh --snapshot /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/00000000000000000000.log

# 3. 检查日志
tail -f /tmp/kraft-combined-logs/server.log | grep -i controller

# 4. 查看 Controller Leader
bin/kafka-metadata-quorum.sh describe --status

# 输出示例:
# ClusterId:              xxxxx
# LeaderId:               1
# LeaderEpoch:            5
# HighWatermark:          12345
# MaxFollowerLag:         0
# CurrentVoters:          [1,2,3]
# CurrentObservers:       []
```

### 10.2 常用操作命令

#### 10.2.1 元数据查询

```bash
# 1. 查看集群元数据
bin/kafka-metadata-shell.sh --snapshot <metadata-log-file>

# 进入交互式 Shell 后可执行:
>> ls
>> cd /brokers
>> ls
>> cat /brokers/ids/0

# 2. 查看元数据 Quorum 状态
bin/kafka-metadata-quorum.sh describe --status

# 3. 查看特定分区的 Leader
bin/kafka-metadata-quorum.sh describe --partition --topic test-topic --partition 0

# 4. 导出元数据到 JSON
bin/kafka-metadata-shell.sh --snapshot <snapshot-file> --export metadata.json
```

#### 10.2.2 Controller 操作

```bash
# 1. 触发 Controller 选举 (通过关闭 Leader)
# 找到 Leader 节点
bin/kafka-metadata-quorum.sh describe --status | grep LeaderId

# 停止 Leader 节点
bin/kafka-server-stop.sh

# 观察新 Leader 选举
bin/kafka-metadata-quorum.sh describe --status --bootstrap-server localhost:9092

# 2. 手动触发快照
# Kafka 会定期自动创建快照，但也可以通过 API 触发
kafka-metadata.sh trigger-snapshot

# 3. 查看元数据日志文件
ls -lh /tmp/kraft-combined-logs/metadata/
# __cluster_metadata-0/
#   ├── 00000000000000000000.log
#   ├── 00000000000000000000.snapshot
#   └── ...
```

### 10.3 验证 KRaft 功能

```bash
# 1. 创建 Topic
bin/kafka-topics.sh --create \
  --topic test-topic \
  --partitions 3 \
  --replication-factor 2 \
  --bootstrap-server localhost:9092

# 2. 验证 Topic 元数据
bin/kafka-topics.sh --describe \
  --topic test-topic \
  --bootstrap-server localhost:9092

# 3. 测试生产消费
bin/kafka-console-producer.sh \
  --topic test-topic \
  --bootstrap-server localhost:9092

bin/kafka-console-consumer.sh \
  --topic test-topic \
  --from-beginning \
  --bootstrap-server localhost:9092

# 4. 验证元数据一致性
# 在不同的 Controller 节点上查询，结果应该一致
for broker in localhost:9092 localhost:9094 localhost:9096; do
  echo "Querying $broker:"
  bin/kafka-topics.sh --describe --bootstrap-server $broker
  echo "---"
done
```

---
