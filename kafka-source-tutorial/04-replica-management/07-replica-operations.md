# 06. 副本操作

## 目录
- [1. 副本创建与删除](#1-副本创建与删除)
- [2. 副本增量与减量](#2-副本增量与减量)
- [3. 跨路径副本迁移](#3-跨路径副本迁移)
- [4. 副本下线与上线](#4-副本下线与上线)
- [5. 操作最佳实践](#5-操作最佳实践)

---

## 1. 副本创建与删除

### 1.1 副本创建流程

```scala
/**
 * 创建副本 - 分区分配时
 */
def createPartition(topicPartition: TopicPartition,
                   replicaAssignment: ReplicaAssignment): Unit = {

  // ========== 步骤1: 创建 Partition 对象 ==========
  val partition = Partition(
    topicPartition = topicPartition,
    replicaAssignment = replicaAssignment,
    time = time,
    replicaManager = this
  )

  // ========== 步骤2: 注册到 allPartitions ==========
  allPartitions.put(topicPartition, HostedPartition.Online(partition))

  // ========== 步骤3: 加载日志 ==========
  partition.getOrCreateReplica(localBrokerId)

  // ========== 步骤4: 初始化副本状态 ==========
  if (replicaId == localBrokerId) {
    // 本地副本
    partition.createLogIfNotExists(isNew = false, isFutureReplica = false)
  }
}
```bash

### 1.2 副本删除流程

```scala
/**
 * 删除副本
 */
def removePartition(topicPartition: TopicPartition): Unit = {
  // ========== 步骤1: 停止副本 ==========
  val partition = allPartitions.get(topicPartition)
  partition.foreach { p =>
    // 停止处理请求
    p.delete()
  }

  // ========== 步骤2: 从 allPartitions 移除 ==========
  allPartitions.remove(topicPartition)

  // ========== 步骤3: 停止拉取线程 ==========
  replicaFetcherManager.removeFetcherForPartitions(Set(topicPartition))

  // ========== 步骤4: 删除日志文件 ==========
  logManager.asyncDelete(topicPartition)

  // ========== 步骤5: 持久化检查点 ==========
  checkpointHighWatermarks()

  info(s"Removed partition $topicPartition")
}
```bash

---

## 2. 副本增量与减量

### 2.1 增加副本

```scala
增加副本操作:

使用 kafka-reassign-partitions.sh

1. 生成重分配方案
cat > increase-replication-factor.json <<EOF
{
  "version": 1,
  "partitions": [
    {
      "topic": "test",
      "partition": 0,
      "replicas": [1, 2, 3, 4]
    }
  ]
}
EOF

2. 执行重分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file increase-replication-factor.json \
  --execute

3. 验证
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file increase-replication-factor.json \
  --verify
```text

### 2.2 减少副本
```scala
减少副本操作:

1. 生成重分配方案
cat > decrease-replication-factor.json <<EOF
{
  "version": 1,
  "partitions": [
    {
      "topic": "test",
      "partition": 0,
      "replicas": [1, 2]
    }
  ]
}
EOF

2. 执行重分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file decrease-replication-factor.json \
  --execute

注意: 减少副本不会立即删除数据
      需要手动清理旧副本
```text

---

## 3. 跨路径副本迁移

### 3.1 迁移原理
```
跨路径迁移场景:

1. 磁盘空间不足
2. 磁盘性能瓶颈
3. 存储分层 (HDD/SSD)

迁移流程:
├── 1. 在目标路径创建副本
├── 2. 开始同步数据
├── 3. 同步完成后切换
└── 4. 删除源路径副本
```bash

### 3.2 迁移操作

```bash
# 使用 kafka-reassign-partitions.sh 的 --generate 功能

# 1. 生成当前分配
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --topics-to-move-json-file topics.json \
  --generate > current.json

# 2. 修改目标路径
# 编辑 current.json, 修改 log.dirs

# 3. 执行迁移
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file migrate.json \
  --execute

# 4. 验证
kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file migrate.json \
  --verify
```text

---

## 4. 副本下线与上线

### 4.1 优雅下线
```bash
# 使用 kafka-stop-shutdown (KIP-399)

# 1. 启动优雅关闭
kafka-stop-shutdown.sh \
  --bootstrap-server localhost:9092 \
  --broker.id 1

# 2. 等待 Leader 迁移完成
# 3. Broker 安全下线

# 或使用 Controlled Shutdown
# 在 broker.properties 中设置
controlled.shutdown.enable=true
```bash

### 4.2 副本上线

```bash
# Broker 启动流程

# 1. 启动 Broker
bin/kafka-server-start.sh config/server.properties

# 2. 自动加载副本
# 3. 恢复 ISR
# 4. 开始同步或成为 Leader
```text

---

## 5. 操作最佳实践

### 5.1 副本操作建议
```text
1. 执行时间
   └── 选择低峰期

2. 监控进度
   └── 使用 --verify

3. 限流
   └── --throttle 参数

4. 备份
   └── 操作前备份元数据

5. 测试
   └── 先在测试环境验证
```

---

**下一步**: [07. 分区重分配](./07-reassignment.md)
