# 日志操作命令

## 目录
- [1. Kafka CLI 工具](#1-kafka-cli-工具)
- [2. 日志管理命令](#2-日志管理命令)
- [3. 数据迁移操作](#3-数据迁移操作)
- [4. 故障恢复操作](#4-故障恢复操作)
- [5. 运维脚本](#5-运维脚本)
- [6. 最佳实践](#6-最佳实践)

---

## 1. Kafka CLI 工具

### 1.1 核心工具列表

```bash
# ========== 日志相关工具 ==========

# 1. kafka-topics.sh - Topic 管理
# 2. kafka-configs.sh - 配置管理
# 3. kafka-log-dirs.sh - 日志目录管理
# 4. kafka-dump-log.sh - 日志内容查看
# 5. kafka-run-class.sh - 运行自定义类
# 6. kafka-reassign-partitions.sh - 分区重分配
# 7. kafka-consumer-groups.sh - 消费者组管理
# 8. kafka-delete-records.sh - 删除记录
```

### 1.2 工具快速参考

| 工具 | 用途 | 常用命令 |
|-----|------|---------|
| **kafka-topics.sh** | Topic 管理 | --create, --list, --describe, --alter, --delete |
| **kafka-configs.sh** | 配置管理 | --describe, --alter |
| **kafka-log-dirs.sh** | 日志目录 | --describe |
| **kafka-dump-log.sh** | 日志查看 | --files, --print-data-log |
| **kafka-reassign-partitions.sh** | 分区重分配 | --generate, --execute, --verify |

---

## 2. 日志管理命令

### 2.1 Topic 管理

```bash
#!/bin/bash
# Topic 管理命令

BROKER="localhost:9092"

# ========== 创建 Topic ==========

# 基础创建
kafka-topics.sh \
  --create \
  --bootstrap-server $BROKER \
  --topic my-topic \
  --partitions 3 \
  --replication-factor 2

# 带配置创建
kafka-topics.sh \
  --create \
  --bootstrap-server $BROKER \
  --topic my-topic \
  --partitions 3 \
  --replication-factor 2 \
  --config retention.ms=604800000 \
  --config segment.bytes=1073741824 \
  --config cleanup.policy=delete

# ========== 查看 Topic ==========

# 列出所有 Topic
kafka-topics.sh \
  --list \
  --bootstrap-server $BROKER

# 查看 Topic 详情
kafka-topics.sh \
  --describe \
  --bootstrap-server $BROKER \
  --topic my-topic

# ========== 修改 Topic ==========

# 增加分区
kafka-topics.sh \
  --alter \
  --bootstrap-server $BROKER \
  --topic my-topic \
  --partitions 6

# 修改配置
kafka-configs.sh \
  --bootstrap-server $BROKER \
  --entity-type topics \
  --entity-name my-topic \
  --alter \
  --add-config retention.ms=1209600000

# ========== 删除 Topic ==========

kafka-topics.sh \
  --delete \
  --bootstrap-server $BROKER \
  --topic my-topic
```

### 2.2 日志目录管理

```bash
#!/bin/bash
# 日志目录管理

BROKER="localhost:9092"
LOG_DIRS="/data1/kafka,/data2/kafka,/data3/kafka"

# ========== 查看日志目录状态 ==========

# 查看所有日志目录
kafka-log-dirs.sh \
  --bootstrap-server $BROKER \
  --describe

# 查看特定 Topic
kafka-log-dirs.sh \
  --bootstrap-server $BROKER \
  --describe \
  --topic-list my-topic

# 查看特定分区
kafka-log-dirs.sh \
  --bootstrap-server $BROKER \
  --describe \
  --topic-list my-topic \
  --partition 0

# 输出示例:
# Topic    Partition  Leader  Replicas  Isr  Directory    Size       Lso        LEO
# my-topic 0         0       [0]       [0]  /data1/kafka 1073741824 0         1000000
```

### 2.3 日志内容查看

```bash
#!/bin/bash
# 日志内容查看

LOG_FILE="/data/kafka/logs/my-topic-0/00000000000000000000.log"

# ========== 查看日志内容 ==========

# 查看数据日志
kafka-dump-log.sh \
  --files $LOG_FILE \
  --print-data-log

# 输出示例:
# Dumping /data/kafka/logs/my-topic-0/00000000000000000000.log
# Starting offset: 0
# BaseOffset: 0 LastOffset: 99 Count: 100 BaseTimestamp: 1640000000000 MaxTimestamp: 1640000100000
# ...

# 查看索引文件
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index \
  --print-data-log

# 验证索引完整性
kafka-dump-log.sh \
  --files /data/kafka/logs/my-topic-0/00000000000000000000.index \
  --verify-index

# ========== 解析消息 ==========

# 解析消息 Key
kafka-dump-log.sh \
  --files $LOG_FILE \
  --print-data-log \
  --key-decoder-classname org.apache.kafka.common.serialization.StringDeserializer

# 解析消息 Value
kafka-dump-log.sh \
  --files $LOG_FILE \
  --print-data-log \
  --value-decoder-classname org.apache.kafka.common.serialization.StringDeserializer

# 深度迭代（解压缩）
kafka-dump-log.sh \
  --files $LOG_FILE \
  --print-data-log \
  --deep-iteration
```

### 2.4 记录删除

```bash
#!/bin/bash
# 删除记录

BROKER="localhost:9092"

# ========== 删除指定 offset 之前的记录 ==========

# 方法1: 使用 delete-records
cat > delete-records.json <<EOF
{
  "partitions": [
    {
      "topic": "my-topic",
      "partition": 0,
      "offset": 1000
    }
  ]
}
EOF

kafka-delete-records.sh \
  --bootstrap-server $BROKER \
  --offset-json-file delete-records.json

# 方法2: 修改保留时间
kafka-configs.sh \
  --bootstrap-server $BROKER \
  --entity-type topics \
  --entity-name my-topic \
  --alter \
  --add-config retention.ms=60000

# 等待清理
sleep 60

# 恢复保留时间
kafka-configs.sh \
  --bootstrap-server $BROKER \
  --entity-type topics \
  --entity-name my-topic \
  --alter \
  --add-config retention.ms=604800000
```

---

## 3. 数据迁移操作

### 3.1 跨目录迁移

```bash
#!/bin/bash
# 跨目录迁移

BROKER="localhost:9092"

# ========== 准备迁移计划 ==========

cat > topics-to-move.json <<EOF
{
  "topics": [
    {"topic": "my-topic"}
  ],
  "version": 1
}
EOF

# ========== 生成迁移计划 ==========

kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --topics-to-move-json-file topics-to-move.json \
  --broker-list "0,1,2" \
  --generate > move-plan.json

# ========== 执行迁移 ==========

kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --reassignment-json-file move-plan.json \
  --execute

# ========== 验证迁移 ==========

kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --reassignment-json-file move-plan.json \
  --verify
```

### 3.2 跨集群迁移

```bash
#!/bin/bash
# 跨集群迁移

SOURCE_BROKER="source-cluster:9092"
TARGET_BROKER="target-cluster:9092"

# ========== 使用 MirrorMaker 2.0 ==========

# 创建迁移配置
cat > mm2.properties <<EOF
# 集群配置
clusters = source, target
source.bootstrap.servers = source-cluster:9092
target.bootstrap.servers = target-cluster:9092

# Topic 配置
source->target.enabled = true
source->target.topics = .*
source->target.group.enable = true

# 复制策略
replication.policy.class = org.apache.kafka.connect.mirror.IdentityReplicationPolicy
sync.group.offsets.enabled = true
emit.heartbeats.enabled = true
emit.heartbeats.interval.seconds = 5
EOF

# 启动 MirrorMaker
kafka-mirror-maker-2.properties mm2.properties

# ========== 验证迁移 ==========

# 检查 Topic
kafka-topics.sh \
  --bootstrap-server $TARGET_BROKER \
  --list | grep "my-topic"

# 检查数据
kafka-console-consumer.sh \
  --bootstrap-server $TARGET_BROKER \
  --topic my-topic \
  --from-beginning \
  --max-messages 10
```

### 3.3 分区重分配

```bash
#!/bin/bash
# 分区重分配

BROKER="localhost:9092"

# ========== 生成重分配计划 ==========

cat > increase-replication-factor.json <<EOF
{
  "version": 1,
  "partitions": [
    {
      "topic": "my-topic",
      "partition": 0,
      "replicas": [0, 1, 2]
    }
  ]
}
EOF

# ========== 执行重分配 ==========

kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --reassignment-json-file increase-replication-factor.json \
  --execute

# ========== 验证重分配 ==========

kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --reassignment-json-file increase-replication-factor.json \
  --verify

# ========== 监控重分配进度 ==========

watch -n 1 '
kafka-reassign-partitions.sh \
  --bootstrap-server $BROKER \
  --reassignment-json-file increase-replication-factor.json \
  --verify
'
```

---

## 4. 故障恢复操作

### 4.1 日志损坏修复

```bash
#!/bin/bash
# 日志损坏修复

LOG_DIR="/data/kafka/logs"
TOPIC="my-topic"
PARTITION=0

# ========== 1. 检测损坏 ==========

# 检查日志文件
kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.log \
  --print-data-log 2>&1 | grep -i "error\|corrupt"

# 检查索引文件
kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index \
  --verify-index 2>&1 | grep -i "invalid\|corrupt"

# ========== 2. 查找最后一个有效 offset ==========

kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.log \
  --print-data-log | \
  grep "BaseOffset:" | \
  tail -1 | \
  awk '{print $2}'

# 假设输出: 9999

# ========== 3. 截断日志 ==========

# 停止 Broker
systemctl stop kafka

# 备份损坏的日志
mv ${LOG_DIR}/${TOPIC}-${PARTITION} ${LOG_DIR}/${TOPIC}-${PARTITION}.bak

# 创建新的日志目录
mkdir -p ${LOG_DIR}/${TOPIC}-${PARTITION}

# 恢复元数据
cp ${LOG_DIR}/${TOPIC}-${PARTITION}.bak/leader-epoch-checkpoint \
   ${LOG_DIR}/${TOPIC}-${PARTITION}/

# 重启 Broker
systemctl start kafka

# ========== 4. 验证修复 ==========

kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic ${TOPIC}
```

### 4.2 索引重建

```bash
#!/bin/bash
# 索引重建

LOG_DIR="/data/kafka/logs"
TOPIC="my-topic"
PARTITION=0

# ========== 删除损坏的索引 ==========

rm ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index
rm ${LOG_DIR}/${TOPIC}-${PARTITION}/*.timeindex

# ========== 重启 Broker 重建索引 ==========

# Kafka 会自动扫描 .log 文件并重建索引
systemctl restart kafka

# ========== 验证索引 ==========

kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index \
  --verify-index
```

### 4.3 数据恢复

```bash
#!/bin/bash
# 数据恢复

LOG_DIR="/data/kafka/logs"
TOPIC="my-topic"
PARTITION=0

# ========== 方法1: 从副本恢复 ==========

# 检查副本状态
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic ${TOPIC}

# 如果副本正常，可以从副本拉取数据

# ========== 方法2. 从备份恢复 ==========

# 停止 Broker
systemctl stop kafka

# 恢复备份
rm -rf ${LOG_DIR}/${TOPIC}-${PARTITION}
cp -r /backup/${TOPIC}-${PARTITION} ${LOG_DIR}/

# 重启 Broker
systemctl start kafka

# ========== 方法3. 从快照恢复 ==========

# 使用快照工具（如 LVM）
lvcreate --snapshot --name kafka-snap --size 10G /dev/vg0/kafka
mount /dev/vg0/kafka-snap /mnt/kafka-snap
cp -r /mnt/kafka-snap/* ${LOG_DIR}/
umount /mnt/kafka-snap
lvremove -f /dev/vg0/kafka-snap
```

---

## 5. 运维脚本

### 5.1 监控脚本

```bash
#!/bin/bash
# log-monitor.sh - 日志监控脚本

BROKER="localhost:9092"
LOG_DIR="/data/kafka/logs"
ALERT_EMAIL="admin@example.com"

echo "=== Log Monitoring Report ==="
echo "Time: $(date)"
echo

# ========== 1. 磁盘使用监控 ==========

echo "1. Disk Usage:"
for dir in $(ls -d ${LOG_DIR}/*); do
  usage=$(df -h $dir | tail -1 | awk '{print $5}' | sed 's/%//')
  if [ $usage -gt 80 ]; then
    echo "  WARNING: $dir usage: ${usage}%"
    # 发送告警
    echo "Disk usage alert: $dir ${usage}%" | mail -s "Kafka Alert" $ALERT_EMAIL
  else
    echo "  $dir usage: ${usage}%"
  fi
done
echo

# ========== 2. 分区状态监控 ==========

echo "2. Partition Status:"
kafka-topics.sh \
  --bootstrap-server $BROKER \
  --describe | \
  awk 'NR>1 {
    topic=$2
    partition=$4
    leader=$6
    replicas=$8
    isr=$10

    if (leader == -1) {
      print "  ERROR: " topic "-" partition " has no leader"
    } else if (replicas != isr) {
      print "  WARNING: " topic "-" partition " replicas not in sync: " replicas " vs " isr
    }
  }'
echo

# ========== 3. 日志段监控 ==========

echo "3. Log Segment Count:"
for topic in $(ls -d ${LOG_DIR}/*-* 2>/dev/null | head -10); do
  topic_name=$(basename "$topic")
  segment_count=$(ls -1 ${topic}/*.log 2>/dev/null | wc -l)
  echo "  $topic_name: $segment_count segments"
done
echo

# ========== 4. 消费者延迟监控 ==========

echo "4. Consumer Lag:"
kafka-consumer-groups.sh \
  --bootstrap-server $BROKER \
  --describe | \
  awk 'NR>1 && $5 > 10000 {
    print "  WARNING: " $1 " lag: " $5
  }'
```

### 5.2 清理脚本

```bash
#!/bin/bash
# log-cleanup.sh - 日志清理脚本

LOG_DIR="/data/kafka/logs"
RETENTION_DAYS=7

echo "=== Log Cleanup Script ==="
echo "Time: $(date)"
echo

# ========== 1. 清理旧数据 ==========

echo "1. Cleaning old data..."
find ${LOG_DIR} -name "*.deleted" -mtime +1 -delete

# ========== 2. 清理临时文件 ==========

echo "2. Cleaning temporary files..."
find ${LOG_DIR} -name "*.swap" -mtime +1 -delete
find ${LOG_DIR} -name "*.tmp" -mtime +1 -delete

# ========== 3. 清理空目录 ==========

echo "3. Cleaning empty directories..."
find ${LOG_DIR} -type d -empty -delete

# ========== 4. 检查磁盘使用 ==========

echo "4. Checking disk usage..."
usage=$(df ${LOG_DIR} | tail -1 | awk '{print $5}' | sed 's/%//')
if [ $usage -gt 80 ]; then
  echo "  WARNING: Disk usage ${usage}%"

  # 列出最大的 Topic
  echo "  Top 5 largest topics:"
  du -sh ${LOG_DIR}/*-* 2>/dev/null | sort -rh | head -5
fi

echo "=== Cleanup Complete ==="
```

### 5.3 备份脚本

```bash
#!/bin/bash
# log-backup.sh - 日志备份脚本

LOG_DIR="/data/kafka/logs"
BACKUP_DIR="/backup/kafka"
DATE=$(date +%Y%m%d_%H%M%S)

echo "=== Log Backup Script ==="
echo "Time: $(date)"
echo

# ========== 1. 创建备份目录 ==========

BACKUP_PATH="${BACKUP_DIR}/${DATE}"
mkdir -p ${BACKUP_PATH}

# ========== 2. 备份元数据 ==========

echo "1. Backing up metadata..."
cp ${LOG_DIR}/meta.properties ${BACKUP_PATH}/
cp -r ${LOG_DIR}/*-checkpoint ${BACKUP_PATH}/ 2>/dev/null

# ========== 3. 备份 Topic 列表 ==========

echo "2. Backing up topic list..."
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --list > ${BACKUP_PATH}/topics.txt

# ========== 4. 备份 Topic 配置 ==========

echo "3. Backing up topic configs..."
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe > ${BACKUP_PATH}/topics-config.txt

# ========== 5. 备份消费者组 ==========

echo "4. Backing up consumer groups..."
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe > ${BACKUP_PATH}/consumer-groups.txt

# ========== 6. 创建快照 ==========

echo "5. Creating snapshot..."
if command -v lvcreate &> /dev/null; then
  lvcreate --snapshot \
    --name kafka-backup-${DATE} \
    --size 10G \
    /dev/vg0/kafka
fi

echo "=== Backup Complete: ${BACKUP_PATH} ==="
```

---

## 6. 最佳实践

### 6.1 日常运维

```bash
# ========== 每日检查 ==========

# 1. 检查磁盘使用
df -h /data/kafka

# 2. 检查日志健康
kafka-topics.sh --bootstrap-server localhost:9092 --describe

# 3. 检查消费者延迟
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe

# ========== 每周维护 ==========

# 1. 清理旧数据
kafka-configs.sh --bootstrap-server localhost:9092 --entity-type topics --describe

# 2. 检查段文件
ls -lh /data/kafka/logs/*/

# ========== 每月优化 ==========

# 1. 性能测试
kafka-producer-perf-test.sh --topic test-topic --num-records 100000

# 2. 配置审查
kafka-configs.sh --bootstrap-server localhost:9092 --describe --entity-type brokers
```

### 6.2 故障处理流程

```
故障处理标准流程:

1. 诊断问题
   - 查看日志: tail -f /var/log/kafka/server.log
   - 检查指标: JMX、Grafana
   - 确认范围: 单节点、单 Topic、全局

2. 隔离问题
   - 停止生产者
   - 降级负载
   - 切换流量

3. 修复问题
   - 根据原因选择修复方案
   - 验证修复效果
   - 恢复正常服务

4. 复盘总结
   - 记录故障原因
   - 更新监控告警
   - 优化防护措施
```

### 6.3 安全操作

```bash
# ========== 操作前检查 ==========

# 1. 确认当前状态
kafka-topics.sh --bootstrap-server localhost:9092 --describe

# 2. 备份配置
kafka-configs.sh --bootstrap-server localhost:9092 --describe > backup-config.txt

# ========== 操作中监控 ==========

# 1. 实时监控日志
tail -f /var/log/kafka/server.log

# 2. 监控 JMX 指标
jconsole localhost:9999

# ========== 操作后验证 ==========

# 1. 验证服务正常
kafka-topics.sh --bootstrap-server localhost:9092 --list

# 2. 验证数据正常
kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic my-topic --max-messages 10
```

---

## 7. 总结

### 7.1 常用命令速查

| 操作 | 命令 |
|-----|------|
| **创建 Topic** | kafka-topics.sh --create |
| **查看 Topic** | kafka-topics.sh --describe |
| **修改配置** | kafka-configs.sh --alter |
| **查看日志** | kafka-dump-log.sh |
| **删除记录** | kafka-delete-records.sh |
| **重分配** | kafka-reassign-partitions.sh |

### 7.2 运维建议

| 场景 | 建议 |
|-----|------|
| **日常监控** | 每日检查磁盘、日志、延迟 |
| **定期维护** | 每周清理临时文件、检查段文件 |
| **故障处理** | 先诊断、再隔离、后修复、最后复盘 |
| **安全操作** | 操作前备份、操作中监控、操作后验证 |

---

**下一章**: [09. 日志监控指标](./09-log-monitoring.md)
