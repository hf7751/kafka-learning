# 故障排查指南

## 目录
- [1. 常见问题诊断](#1-常见问题诊断)
- [2. 性能问题定位](#2-性能问题定位)
- [3. 数据损坏修复](#3-数据损坏修复)
- [4. 故障恢复流程](#4-故障恢复流程)
- [5. 案例分析](#5-案例分析)
- [6. 预防措施](#6-预防措施)

---

## 1. 常见问题诊断

### 1.1 写入慢问题

```bash
#!/bin/bash
# diagnose-write-slow.sh - 写入慢问题诊断

echo "=== Diagnosing Slow Write Issues ==="

# ========== 1. 检查磁盘 I/O ==========

echo "1. Checking disk I/O:"
iostat -x 1 5 | grep -E "Device|kafka"

# 阈值:
# - await: < 10ms (正常), 10-50ms (警告), > 50ms (告警)
# - %util: < 60% (正常), 60-80% (警告), > 80% (告警)

# ========== 2. 检查刷盘策略 ==========

echo "2. Checking flush policy:"
grep "log.flush.interval" /opt/kafka/config/server.properties

# 问题: log.flush.interval.messages=1 会导致性能严重下降

# ========== 3. 检查段滚动 ==========

echo "3. Checking segment rolling:"
for topic in $(ls -d /data/kafka/logs/*-* 2>/dev/null | head -5); do
  active_segment=$(ls -t $topic/*.log 2>/dev/null | head -1)
  if [ -n "$active_segment" ]; then
    size=$(stat -c%s "$active_segment" 2>/dev/null || stat -f%z "$active_segment")
    echo "$(basename $topic): active segment size = $size bytes"
  fi
done

# ========== 4. 检查网络带宽 ==========

echo "4. Checking network bandwidth:
iftop -i eth0 -t -s 10

# ========== 5. 检查 CPU 使用 ==========

echo "5. Checking CPU usage:"
top -bn1 | grep kafka

# 阈值:
# - %CPU: < 70% (正常), 70-90% (警告), > 90% (告警)

# ========== 诊断结论 ==========

echo "=== Diagnosis Summary ==="

# 如果 disk await > 50ms
# → 磁盘瓶颈，考虑升级 SSD 或多目录

# 如果 flush interval = 1
# → 调整为更大的值，依赖 OS 刷盘

# 如果 active segment size 接近 max segment bytes
# → 段滚动频繁，增加 max.segment.bytes

# 如果 CPU > 90%
# → 压缩算法开销大，考虑切换到 LZ4
```

### 1.2 读取慢问题

```bash
#!/bin/bash
# diagnose-read-slow.sh - 读取慢问题诊断

echo "=== Diagnosing Slow Read Issues ==="

# ========== 1. 检查消费者延迟 ==========

echo "1. Checking consumer lag:"
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe | \
  awk 'NR>1 && $5 > 10000 {
    print "WARNING: " $1 " lag: " $5 " messages"
  }'

# ========== 2. 检查页缓存 ==========

echo "2. Checking page cache:"
grep -i cache /proc/meminfo

# 如果 Cached 很小
# → OS 页缓存不足，增加内存或调整 swappiness

# ========== 3. 检查索引密度 ==========

echo "3. Checking index density:"
for topic in $(ls -d /data/kafka/logs/*-* 2>/dev/null | head -5); do
  log_size=$(du -s $topic | awk '{print $1}' | awk '{print $1*1024}')
  index_size=$(du -s $topic/*.index 2>/dev/null | awk '{sum+=$1} END {print sum*1024}')

  if [ $log_size -gt 0 ]; then
    ratio=$(echo "scale=4; $index_size / $log_size" | bc)
    echo "$(basename $topic): index ratio = $ratio"
  fi
done

# ========== 4. 检查零拷贝 ==========

echo "4. Checking zero-copy:"
cat /proc/sys/net/core/rmem_max
cat /proc/sys/net/core/wmem_max
cat /proc/sys/net/core/netdev_max_backlog

# ========== 诊断结论 ==========

echo "=== Diagnosis Summary ==="

# 如果 consumer lag 很大
# → 消费速度慢，增加消费者实例

# 如果 index ratio 很大
# → 索引太密，增加 log.index.interval.bytes

# 如果页缓存很小
# → OS 缓存不足，增加内存或调整 vm.swappiness
```

### 1.3 磁盘空间问题

```bash
#!/bin/bash
# diagnose-disk-space.sh - 磁盘空间问题诊断

echo "=== Diagnosing Disk Space Issues ==="

# ========== 1. 检查磁盘使用 ==========

echo "1. Checking disk usage:"
df -h /data/kafka

# ========== 2. 查找大文件 ==========

echo "2. Finding large files:"
find /data/kafka/logs -type f -name "*.log" -size +1G -exec ls -lh {} \;

# ========== 3. 分析 Topic 空间分布 ==========

echo "3. Analyzing topic space distribution:"
for topic in $(ls -d /data/kafka/logs/*-* 2>/dev/null); do
  size=$(du -sh $topic 2>/dev/null | awk '{print $1}')
  echo "$(basename $topic): $size"
done | sort -h -k2 -r | head -10

# ========== 4. 检查清理策略 ==========

echo "4. Checking cleanup policy:"
for topic in $(ls -d /data/kafka/logs/*-* 2>/dev/null | head -5); do
  topic_name=$(basename "$topic" | sed 's/-.*//')
  kafka-configs.sh \
    --bootstrap-server localhost:9092 \
    --entity-type topics \
    --entity-name $topic_name \
    --describe 2>/dev/null | grep -E "cleanup.policy|retention"
done

# ========== 5. 检查 .deleted 文件 ==========

echo "5. Checking .deleted files:"
find /data/kafka/logs -name "*.deleted" -mtime +1 | wc -l

# ========== 诊断结论 ==========

echo "=== Diagnosis Summary ==="

# 如果磁盘使用 > 80%
# → 清理旧数据或扩容

# 如果某个 Topic 占用空间过大
# → 调整该 Topic 的保留策略

# 如果 .deleted 文件很多
# → 删除线程未工作，检查 log cleaner 配置
```

---

## 2. 性能问题定位

### 2.1 性能分析工具

```bash
#!/bin/bash
# performance-analysis.sh - 性能分析脚本

echo "=== Kafka Performance Analysis ==="

# ========== 1. 系统资源分析 ==========

echo "1. System Resources:"
echo "CPU:"
top -bn1 | grep "Cpu(s)"
echo "Memory:"
free -h
echo "Disk I/O:"
iostat -x 1 2 | tail -n +3

# ========== 2. JVM 分析 ==========

echo "2. JVM Analysis:"
PID=$(ps aux | grep kafka | grep -v grep | awk '{print $1}' | head -1)

if [ -n "$PID" ]; then
  echo "Heap Usage:"
  jstat -gc $PID | tail -1

  echo "GC Statistics:"
  jstat -gcutil $PID 1000 5

  echo "Thread Count:"
  ps -o nlwp $PID
fi

# ========== 3. Kafka 指标分析 ==========

echo "3. Kafka Metrics:"
kafka-broker-api-versions.sh --bootstrap-server localhost:9092

# ========== 4. 网络分析 ==========

echo "4. Network Analysis:"
sar -n DEV 1 5

# ========== 5. 磁盘性能测试 ==========

echo "5. Disk Performance Test:"
dd if=/dev/zero of=/data/kafka/test.tmp bs=1M count=1024 oflag=direct
rm /data/kafka/test.tmp

# ========== 性能报告 ==========

echo "=== Performance Report ==="
echo "生成详细报告: /var/log/kafka/performance-$(date +%Y%m%d-%H%M%S).log"
```

### 2.2 瓶颈识别

```bash
#!/bin/bash
# bottleneck-identification.sh - 瓶颈识别

echo "=== Bottleneck Identification ==="

# ========== 1. CPU 瓶颈 ==========

cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)

if (( $(echo "$cpu_usage > 80" | bc -l) )); then
  echo "WARNING: CPU usage is high: ${cpu_usage}%"

  # 分析 CPU 使用
  ps aux --sort=-%cpu | head -10 | grep kafka

  # 建议:
  # - 如果是用户态 CPU 高: 应用计算密集，优化代码或增加线程
  # - 如果是系统态 CPU 高: 系统调用频繁，检查系统调用
fi

# ========== 2. 内存瓶颈 ==========

mem_usage=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100.0}')

if [ $mem_usage -gt 80 ]; then
  echo "WARNING: Memory usage is high: ${mem_usage}%"

  # 分析内存使用
  ps aux --sort=-%mem | head -10 | grep kafka

  # 建议:
  # - 增加 JVM 堆内存
  # - 调整页缓存大小
  # - 检查内存泄漏
fi

# ========== 3. 磁盘 I/O 瓶颈 ==========

io_util=$(iostat -x 1 2 | grep avg | awk '{print $12}' | tail -1)

if (( $(echo "$io_util > 80" | bc -l) )); then
  echo "WARNING: Disk I/O utilization is high: ${io_util}%"

  # 分析 I/O
  iostat -x 1 5

  # 建议:
  # - 升级到 SSD
  # - 使用多目录分散 I/O
  # - 减少刷盘频率
fi

# ========== 4. 网络瓶颈 ==========

network_in=$(sar -n DEV 1 2 | grep Average | grep eth0 | awk '{print $5}')
network_out=$(sar -n DEV 1 2 | grep Average | grep eth0 | awk '{print $6}')

echo "Network: IN=${network_in} KB/s, OUT=${network_out} KB/s"

# 建议:
# - 如果接近带宽上限: 升级网络或增加网卡
# - 如果错误包多: 检查网络设备
```

---

## 3. 数据损坏修复

### 3.1 日志文件损坏

```bash
#!/bin/bash
# repair-corrupted-log.sh - 修复损坏的日志

LOG_DIR="/data/kafka/logs"
TOPIC="my-topic"
PARTITION=0

echo "=== Repairing Corrupted Log ==="

# ========== 1. 检测损坏 ==========

echo "1. Detecting corruption:"
kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.log \
  --print-data-log 2>&1 | grep -i "error\|corrupt"

# ========== 2. 备份损坏数据 ==========

echo "2. Backing up corrupted data:"
cp -r ${LOG_DIR}/${TOPIC}-${PARTITION} ${LOG_DIR}/${TOPIC}-${PARTITION}.bak

# ========== 3. 查找最后一个有效 offset ==========

echo "3. Finding last valid offset:"
last_valid=$(kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.log \
  --print-data-log 2>/dev/null | \
  grep "BaseOffset:" | \
  tail -1 | \
  awk '{print $2}')

echo "Last valid offset: $last_valid"

# ========== 4. 截断日志 ==========

echo "4. Truncating log:"

# 停止 Broker
systemctl stop kafka

# 删除损坏的段
find ${LOG_DIR}/${TOPIC}-${PARTITION} -name "*.log" -exec rm {} \;
find ${LOG_DIR}/${TOPIC}-${PARTITION} -name "*.index" -exec rm {} \;
find ${LOG_DIR}/${TOPIC}-${PARTITION} -name "*.timeindex" -exec rm {} \;

# 重建元数据
cat > ${LOG_DIR}/${TOPIC}-${PARTITION}/leader-epoch-checkpoint <<EOF
0
0 $last_valid
EOF

# 重启 Broker
systemctl start kafka

# ========== 5. 验证修复 ==========

echo "5. Verifying repair:"
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic ${TOPIC}
```

### 3.2 索引文件损坏

```bash
#!/bin/bash
# repair-corrupted-index.sh - 修复损坏的索引

LOG_DIR="/data/kafka/logs"
TOPIC="my-topic"
PARTITION=0

echo "=== Repairing Corrupted Index ==="

# ========== 1. 检测损坏 ==========

echo "1. Detecting corruption:"
kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index \
  --verify-index 2>&1 | grep -i "invalid\|corrupt"

# ========== 2. 删除损坏的索引 ==========

echo "2. Removing corrupted index:"
rm ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index
rm ${LOG_DIR}/${TOPIC}-${PARTITION}/*.timeindex

# ========== 3. 重启 Broker 重建索引 ==========

echo "3. Rebuilding index:"
systemctl restart kafka

# ========== 4. 验证重建 ==========

echo "4. Verifying rebuild:"
kafka-dump-log.sh \
  --files ${LOG_DIR}/${TOPIC}-${PARTITION}/*.index \
  --verify-index
```

### 3.3 数据恢复

```bash
#!/bin/bash
# data-recovery.sh - 数据恢复

LOG_DIR="/data/kafka/logs"
BACKUP_DIR="/backup/kafka"
TOPIC="my-topic"

echo "=== Data Recovery ==="

# ========== 方法1: 从副本恢复 ==========

echo "Method 1: Recovering from replica"

# 检查副本状态
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic ${TOPIC}

# 如果副本正常，可以强制重新同步
# 注意: 这会导致数据丢失

# ========== 方法2: 从备份恢复 ==========

echo "Method 2: Recovering from backup"

# 停止 Broker
systemctl stop kafka

# 恢复备份
rm -rf ${LOG_DIR}/${TOPIC}-*
cp -r ${BACKUP_DIR}/${TOPIC}-* ${LOG_DIR}/

# 重启 Broker
systemctl start kafka

# ========== 方法3: 从快照恢复 ==========

echo "Method 3: Recovering from snapshot"

# 使用 LVM 快照
lvcreate --snapshot \
  --name kafka-snap \
  --size 10G \
  /dev/vg0/kafka

mount /dev/vg0/kafka-snap /mnt/kafka-snap
cp -r /mnt/kafka-snap/* ${LOG_DIR}/
umount /mnt/kafka-snap
lvremove -f /dev/vg0/kafka-snap
```

---

## 4. 故障恢复流程

### 4.1 Broker 故障恢复

```bash
#!/bin/bash
# broker-failure-recovery.sh - Broker 故障恢复

echo "=== Broker Failure Recovery ==="

# ========== 1. 确认故障 ==========

echo "1. Confirming failure:"
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe | \
  awk '$6 == -1 {print "ERROR: " $2 "-" $4 " has no leader"}'

# ========== 2. 检查 Leader 选举 ==========

echo "2. Checking leader election:"
kafka-leader-election.sh \
  --bootstrap-server localhost:9092 \
  --topic my-topic \
  --partition 0 \
  --election-type PREFERRED

# ========== 3. 验证恢复 ==========

echo "3. Verifying recovery:"
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe
```

### 4.2 分区不可用恢复

```bash
#!/bin/bash
# partition-unavailable-recovery.sh - 分区不可用恢复

echo "=== Partition Unavailable Recovery ==="

# ========== 1. 识别不可用分区 ==========

echo "1. Identifying unavailable partitions:"
kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe | \
  awk '$6 == -1 {print $2 "-" $4}' > /tmp/unavailable.txt

cat /tmp/unavailable.txt

# ========== 2. 尝试重新分配分区 ==========

echo "2. Reassigning partitions:"

# 生成分配方案
cat > /tmp/reassign.json <<EOF
{
  "version": 1,
  "partitions": [
$(cat /tmp/unavailable.txt | while read tp; do
  topic=$(echo $tp | cut -d'-' -f1)
  partition=$(echo $tp | cut -d'-' -f2)
  echo "    {\"topic\": \"$topic\", \"partition\": $partition, \"replicas\": [0, 1, 2]},"
done | sed '$ s/,$//')
  ]
}
EOF

# 执行重分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/reassign.json \
  --execute

# ========== 3. 验证恢复 ==========

echo "3. Verifying recovery:"
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/reassign.json \
  --verify
```

---

## 5. 案例分析

### 5.1 案例1: 磁盘 I/O 瓶颈

```
问题现象:
- 生产者发送延迟高
- 消费者消费速度慢
- 磁盘 I/O 使用率 100%

诊断过程:
1. iostat -x 1 5 显示 await > 100ms
2. 查看日志目录在单块 HDD 上
3. log.flush.interval.messages=1，每条消息强制刷盘

解决方案:
1. 调整刷盘策略: log.flush.interval.messages=10000
2. 增加日志目录: log.dirs=/data1/kafka,/data2/kafka,/data3/kafka
3. 升级到 SSD

效果:
- 磁盘 I/O 使用率降至 60%
- 生产延迟降至 50ms
- 消费速度提升 3 倍
```

### 5.2 案例2: 内存不足

```
问题现象:
- 频繁 Full GC
- Broker 响应慢
- OutOfMemoryError

诊断过程:
1. jstat -gcutil 显示 Full GC 频繁
2. 堆内存太小: -Xmx2G
3. 页缓存不足

解决方案:
1. 增加 JVM 堆内存: -Xmx8G -Xms8G
2. 调整 GC 策略: -XX:+UseG1GC
3. 增加 Swap 空间
4. 优化生产者 batch.size

效果:
- Full GC 频率降低 90%
- 响应时间降低 50%
- 不再出现 OOM
```

### 5.3 案例3: 消费者延迟

```
问题现象:
- 消费者延迟持续增长
- 日志文件很大
- 消费速度慢

诊断过程:
1. kafka-consumer-groups.sh 显示 lag 很大
2. log.index.interval.bytes=512，索引太密
3. 消费者单线程

解决方案:
1. 调整索引间隔: log.index.interval.bytes=4096
2. 增加消费者实例
3. 增加 max.partition.fetch.bytes
4. 优化 fetch.min.bytes

效果:
- 消费速度提升 5 倍
- 延迟逐渐降低
- 最终追上生产速度
```

---

## 6. 预防措施

### 6.1 监控告警

```bash
#!/bin/bash
# setup-alerts.sh - 设置告警

# ========== 1. 磁盘空间告警 ==========

cat > /etc/prometheus/rules/kafka.yml <<EOF
groups:
  - name: kafka_alerts
    rules:
      - alert: KafkaDiskSpaceLow
        expr: node_filesystem_avail_bytes{mountpoint="/data/kafka"} / node_filesystem_size_bytes{mountpoint="/data/kafka"} < 0.2
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Kafka disk space low"
EOF

# ========== 2. 性能告警 ==========

cat >> /etc/prometheus/rules/kafka.yml <<EOF
      - alert: KafkaHighLatency
        expr: histogram_quantile(0.99, rate(kafka_network_RequestMetrics_Name_LocalTimeMs_request_Produce_bucket[5m])) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka latency high"
EOF

# ========== 3. 可用性告警 ==========

cat >> /etc/prometheus/rules/kafka.yml <<EOF
      - alert: KafkaBrokerDown
        expr: up{job="kafka"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka broker down"
EOF

# 重启 Prometheus
systemctl restart prometheus
```

### 6.2 定期维护

```bash
#!/bin/bash
# regular-maintenance.sh - 定期维护

# ========== 每日检查 ==========

# 1. 检查磁盘使用
df -h /data/kafka

# 2. 检查日志健康
kafka-topics.sh --bootstrap-server localhost:9092 --describe

# 3. 检查消费者延迟
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe

# ========== 每周维护 ==========

# 1. 清理临时文件
find /data/kafka/logs -name "*.deleted" -mtime +1 -delete

# 2. 检查段文件
ls -lh /data/kafka/logs/*/

# 3. 分析性能
kafka-producer-perf-test.sh --topic test-topic --num-records 100000

# ========== 每月优化 ==========

# 1. 配置审查
kafka-configs.sh --bootstrap-server localhost:9092 --describe --entity-type brokers

# 2. 容量规划
# 评估是否需要扩容

# 3. 备份验证
# 验证备份数据的完整性
```

---

## 7. 总结

### 7.1 故障处理流程

```
标准故障处理流程:

1. 发现问题
   - 监控告警
   - 用户反馈
   - 定期检查

2. 诊断问题
   - 收集日志
   - 分析指标
   - 定位根因

3. 解决问题
   - 选择方案
   - 执行修复
   - 验证效果

4. 复盘总结
   - 记录问题
   - 更新监控
   - 预防措施
```

### 7.2 常用诊断命令

| 问题 | 命令 |
|-----|------|
| **写入慢** | iostat -x, kafka-producer-perf-test.sh |
| **读取慢** | kafka-consumer-groups.sh, free |
| **磁盘满** | df -h, du -sh |
| **高延迟** | jstat, kafka-topics.sh |
| **数据损坏** | kafka-dump-log.sh |

### 7.3 最佳实践

| 实践 | 说明 |
|-----|------|
| **监控** | 建立完善的监控告警体系 |
| **备份** | 定期备份配置和数据 |
| **文档** | 记录所有故障处理过程 |
| **演练** | 定期进行故障演练 |
| **优化** | 持续优化配置和性能 |

---

**返回**: [README](./README.md)
