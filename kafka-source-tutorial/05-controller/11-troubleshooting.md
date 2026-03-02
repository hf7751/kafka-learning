# 11. 故障排查指南

> **本文档导读**
>
> 本文档提供常见故障的排查方法和解决方案。
>
> **预计阅读时间**: 45 分钟
>
> **相关文档**:
> - [10-monitoring.md](./10-monitoring.md) - 监控与指标
> - [19-faq.md](./19-faq.md) - 常见问题解答

---

## 12. 故障排查指南

### 12.1 Controller 选举失败

#### 现象

```bash
# 日志显示选举超时
[Controller] Election timeout, starting new election

# 无法选出 Leader
bin/kafka-metadata-quorum.sh describe --status
# LeaderId: -1 (无 Leader)
```

#### 排查步骤

```bash
# 1. 检查网络连通性
nc -zv localhost 9093
nc -zv localhost 9094
nc -zv localhost 9095

# 2. 验证配置文件
grep "controller.quorum.voters" config/kraft/server.properties

# 3. 检查节点 ID 是否冲突
grep "node.id" config/kraft/*.properties

# 4. 查看日志中的错误
grep -i "error" /tmp/kraft-combined-logs/server.log | grep -i controller

# 5. 检查磁盘空间
df -h /tmp/kraft-combined-logs

# 6. 验证元数据日志文件
ls -la /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/
```

#### 常见原因

```
┌─────────────────────────────────────────────────────────────┐
│                    Controller 选举失败原因                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 网络问题                                                │
│     ├── Controller 节点之间网络不通                         │
│     ├── 防火墙阻止 Raft 通信端口                            │
│     └── DNS 解析问题                                        │
│                                                             │
│  2. 配置错误                                                │
│     ├── controller.quorum.voters 配置不一致                 │
│     ├── node.id 冲突                                        │
│     └── listener 配置错误                                   │
│                                                             │
│  3. 资源不足                                                │
│     ├── 磁盘空间不足                                        │
│     ├── 内存不足                                            │
│     └── CPU 占用过高                                        │
│                                                             │
│  4. 元数据损坏                                              │
│     ├── 日志文件损坏                                        │
│     ├── 快照文件损坏                                        │
│     └── 格式化失败                                          │
│                                                             │
│  5. 时钟偏差                                                │
│     ├── 节点时间不同步                                      │
│     └── NTP 服务未启动                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 解决方案

```bash
# 方案 1: 重新配置网络
# 确保所有 Controller 节点可以互相通信
for port in 9093 9094 9095; do
  nc -zv localhost $port
done

# 方案 2: 同步配置
# 确保所有节点的 controller.quorum.voters 一致
cat config/kraft/server.properties | grep voters

# 方案 3: 清理并重新格式化
# 停止所有节点
bin/kafka-server-stop.sh

# 清理元数据目录 (谨慎操作!)
rm -rf /tmp/kraft-combined-logs/metadata

# 重新生成集群 ID 并格式化
KAFKA_CLUSTER_ID=$(bin/kafka-storage.sh random-uuid)
bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server.properties

# 方案 4: 调整选举超时
# 在 server.properties 中增加超时时间
controller.quorum.election.timeout.ms=5000

# 方案 5: 同步时间
# 启动 NTP 服务
systemctl start ntpd
systemctl enable ntpd

# 验证时间同步
ntpq -p
```

### 12.2 元数据不一致

#### 现象

```bash
# 不同节点显示的 Topic 列表不一致
# 在 Broker 1 查询
bin/kafka-topics.sh --list --bootstrap-server localhost:9092
# topic1, topic2

# 在 Broker 2 查询
bin/kafka-topics.sh --list --bootstrap-server localhost:9094
# topic1, topic2, topic3  ← 不一致!
```

#### 排查步骤

```bash
# 1. 检查 Controller 状态
bin/kafka-metadata-quorum.sh describe --status

# 2. 检查元数据发布状态
bin/kafka-metadata-quorum.sh describe --replication

# 3. 查看 Broker 注册信息
bin/kafka-metadata-shell.sh --snapshot <snapshot-file>
>> cd /brokers/ids
>> ls

# 4. 检查日志中的元数据发布事件
grep "MetadataPublisher" /tmp/kraft-combined-logs/server.log

# 5. 验证 __cluster_metadata Topic
bin/kafka-console-consumer.sh \
  --topic __cluster_metadata \
  --bootstrap-server localhost:9092 \
  --formatter kafka.tools.DefaultMessageFormatter \
  --from-beginning --max-messages 10
```

#### 解决方案

```bash
# 方案 1: 触发元数据重载
# 重启 Follower Broker
bin/kafka-server-stop.sh
bin/kafka-server-start.sh -daemon config/kraft/server.properties

# 方案 2: 强制元数据同步
# 等待下一次 MetadataImage 更新周期 (默认 1 秒)

# 方案 3: 检查并修复 Broker 注册
# 移除故障 Broker
bin/kafka-metadata.sh delete-broker --id <broker-id>

# 重新注册 Broker
bin/kafka-server-start.sh -daemon config/kraft/server.properties

# 方案 4: 验证网络延迟
# 如果网络延迟过高，增加元数据更新间隔
metadata.publisher.max.delay.ms=5000
```

### 12.3 性能问题诊断

#### 现象

```bash
# 元数据操作响应慢
bin/kafka-topics.sh --create --topic test --bootstrap-server localhost:9092
# 响应时间 > 5s

# Raft 提交延迟高
# JMX 指标显示 CommitLatencyMs > 1000ms
```

#### 诊断工具

```bash
# 1. 开启调试日志
# 在 log4j.properties 中添加
log4j.logger.kafka.controller=DEBUG
log4j.logger.kafka.raft=DEBUG

# 2. 使用 JMX 监控
jconsole
# 连接到 Kafka 进程
# 查看 kafka.raft 和 kafka.controller MBean

# 3. 分析线程状态
jstack <pid> | grep -A 10 "controller"

# 4. 查看 Raft 指标
curl http://localhost:9092/metrics | grep raft

# 5. 性能分析
# 使用 async-profiler 生成火焰图
profiler.sh -d 30 -f profile.html <pid>
```

#### 优化建议

```properties
# ==================== 性能调优配置 ====================

# 1. 增加批量写入大小
metadata.log.max.record.bytes.between.snapshots=50000

# 2. 调整快照策略
metadata.log.max.snapshot.interval.bytes=104857600

# 3. 增加事件队列容量
controller.event.queue.size=10000

# 4. 调整 Raft 超时
controller.quorum.append.linger.ms=10
controller.quorum.fetch.max.wait.ms=50

# 5. 启用压缩
compression.type=producer
```

---
