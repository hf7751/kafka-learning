# 05. 副本同步与 ISR

## 目录
- [1. ISR 机制详解](#1-isr-机制详解)
- [2. LEO 与 HW 管理](#2-leo-与-hw-管理)
- [3. ISR 扩展与收缩](#3-isr-扩展与收缩)
- [4. 数据一致性保障](#4-数据一致性保障)
- [5. 同步性能调优](#5-同步性能调优)

---

## 1. ISR 机制详解

### 1.1 ISR 核心概念

```scala
/**
 * ISR (In-Sync Replicas) - 同步副本集合
 *
 * 设计思想:
 * 1. 动态调整: 慢副本被移出，快副本加入
 * 2. 高可用性: ISR 中所有副本都是可用的
 * 3. 一致性保障: HW 只推进到 ISR 中最慢的副本
 *
 * ISR 调整条件:
 * - 扩展 (Expand): Follower 赶上 Leader
 * - 收缩 (Shrink): Follower 滞后太久
 */
```bash

### 1.2 ISR 状态图

```mermaid
stateDiagram-v2
    [*] --> Follower: 副本创建

    Follower --> ISR: 追上 Leader
    Follower --> OSR: 滞后太久

    ISR --> Follower: 滞后
    ISR --> Leader: 被选为 Leader

    OSR --> ISR: 恢复同步
    OSR --> [*]: 副本删除

    Leader --> [*]: 下线

    note right of ISR
        ISR = In-Sync Replicas
        可以参与 Leader 选举
        HW 推进到此
    end note

    note right of OSR
        OSR = Out-of-Sync Replicas
        不能参与 Leader 选举
        需要完全追赶才能加入 ISR
    end note
```scala

### 1.3 ISR 收缩 (Shrink)

```scala
/**
 * ISR 收缩机制 - 移除滞后的副本
 *
 * 触发条件:
 * - 定期检查 (默认: replica.lag.time.max.ms / 2)
 * - Follower 滞后时间超过 replica.lag.time.max.ms
 *
 * 流程:
 * 1. 检查每个 Follower 的 lastCaughtUpTimeMs
 * 2. 如果超时，从 ISR 中移除
 * 3. 更新 Leader Epoch
 * 4. 通知 Controller
 */
def maybeShrinkIsr(): Unit = {
  // ========== 步骤1: 遍历所有 Leader 分区 ==========
  leaderPartitionsIterator.foreach { partition =>
    try {
      // ========== 步骤2: 检查是否需要收缩 ISR ==========
      val outOfSyncReplicas = partition.getOutOfSyncReplicas(
        replicaLagTimeMaxMs = config.replicaLagTimeMaxMs
      )

      if (outOfSyncReplicas.nonEmpty) {
        // ========== 步骤3: 收缩 ISR ==========
        val newIsr = partition.inSyncReplicaIds -- outOfSyncReplicas

        // ========== 步骤4: 更新分区状态 ==========
        partition.maybeShrinkIsr(newIsr.toSet)

        // ========== 步骤5: 记录指标 ==========
        isrShrinksPerSec.mark()

        info(
          s"Shrunk ISR for partition ${partition.topicPartition}\n" +
          s"Old ISR: ${partition.inSyncReplicaIds.mkString(",")}\n" +
          s"New ISR: ${newIsr.mkString(",")}\n" +
          s"Removed: ${outOfSyncReplicas.mkString(",")}"
        )
      }
    } catch {
      case e: Exception =>
        error(s"Error shrinking ISR for partition ${partition.topicPartition}", e)
        failedIsrUpdatesPerSec.mark()
    }
  }
}

/**
 * Partition.getOutOfSyncReplicas() - 识别不同步的副本
 */
private def getOutOfSyncReplicas(replicaLagTimeMaxMs: Long): Set[Int] = {
  inSyncReplicaIds.flatMap { replicaId =>
    val replica = remoteReplica(replicaId).getOrElse {
      // 副本不存在，视为不同步
      return Some(replicaId)
    }

    // ========== 判断是否不同步 ==========
    // 计算滞后时间
    val lastCaughtUpTimeMs = replica.lastCaughtUpTimeMs
    val currentTimeMs = time.milliseconds()
    val lagMs = currentTimeMs - lastCaughtUpTimeMs

    if (lagMs > replicaLagTimeMaxMs) {
      // 滞后超过阈值，需要移出 ISR
      Some(replicaId)
    } else {
      None
    }
  }
}
```bash

### 1.4 ISR 扩展 (Expand)

```scala
/**
 * ISR 扩展机制 - 将赶上的副本加入 ISR
 *
 * 触发条件:
 * - Follower 的 LEO (Log End Offset) ≥ Old Leader Epoch 的 HW
 *
 * 流程:
 * 1. Follower 拉取数据时更新自己的 LEO
 * 2. Leader 收到 FetchRequest，检查 Follower 的 LEO
 * 3. 如果满足条件，将 Follower 加入 ISR
 * 4. 更新 HW
 */
private def maybeExpandIsr(partition: Partition): Unit = {
  val leaderLog = partition.localLogOrException
  val currentIsr = partition.inSyncReplicaIds

  // ========== 步骤1: 获取所有副本的 LEO ==========
  val replicaLogEndOffsets = partition.remoteReplicas.map { replica =>
    replica.id -> replica.lastFetchLeaderLogEndOffset
  }.toMap

  // ========== 步骤2: 识别可以加入 ISR 的副本 ==========
  val candidateReplicaIds = replicaLogEndOffsets.filter { case (replicaId, leo) =>
    // 条件: LEO >= Old Leader Epoch 的 HW
    !currentIsr.contains(replicaId) && leo >= partition.highWatermark
  }.keySet

  // ========== 步骤3: 计算新 ISR ==========
  val newIsr = currentIsr ++ candidateReplicaIds

  if (newIsr.size > currentIsr.size) {
    // ========== 步骤4: 更新 ISR ==========
    partition.expandIsr(newIsr)

    // ========== 步骤5: 记录指标 ==========
    isrExpandRate.mark()

    info(
      s"Expanded ISR for partition ${partition.topicPartition}\n" +
      s"Old ISR: ${currentIsr.mkString(",")}\n" +
      s"New ISR: ${newIsr.mkString(",")}\n" +
      s"Added: ${candidateReplicaIds.mkString(",")}"
    )
  }
}
```scala

---

## 2. LEO 与 HW 管理

### 2.1 LEO (Log End Offset)

```java
/**
 * LEO - Log End Offset
 *
 * 定义: 日志末尾 Offset (下一条待写入消息的 Offset)
 *
 * 作用:
 * - Leader: 追加消息后递增
 * - Follower: 拉取并写入后递增
 * - 用于判断 Follower 是否追上
 */

/**
 * Partition 维护的 LEO 映射
 */
public class Partition {
    // ========== 副本 LEO 映射 ==========
    // Key: replicaId, Value: 该副本的 LEO
    private final ConcurrentMap<Integer, Long> remoteReplicaLEO = new ConcurrentHashMap<>();

    /**
     * 更新 Follower 的 LEO
     */
    public void updateFollowerFetchState(
        int replicaId,
        long fetchOffset,
        long leaderEpoch
    ) {
        // ========== 步骤1: 更新 LEO ==========
        remoteReplicaLEO.put(replicaId, fetchOffset);

        // ========== 步骤2: 检查是否需要扩展 ISR ==========
        if (maybeExpandIsr()) {
            // ISR 扩展了
        }

        // ========== 步骤3: 检查是否需要推进 HW ==========
        maybeUpdateHighWatermark(leaderLog);
    }

    /**
     * 获取副本的 LEO
     */
    public long followerReplicaLEO(int replicaId) {
        return remoteReplicaLEO.getOrDefault(replicaId, 0L);
    }
}
```bash

### 2.2 HW (High Watermark)

```scala
/**
 * HW - High Watermark (高水位)
 *
 * 定义: ISR 中所有副本都已同步的 Offset
 *
 * 作用:
 * 1. 数据可见性: ≤ HW 的消息对 Consumer 可见
 * 2. 一致性保障: 已提交消息 (Committed)
 * 3. 故障恢复: ISR 中任一副本成为 Leader，都不会丢失数据
 *
 * 示例:
 * Leader  LEO = 10 (本地有 10 条消息)
 * Follower LEO = 8  (有 8 条消息)
 * Follower LEO = 7  (有 7 条消息)
 * → HW = 7 (取 ISR 中的最小 LEO)
 * → Offset ≤ 7 的消息是"已提交"的
 */
```text

### 2.3 HW 更新流程
```mermaid
graph TD
    Start[Follower 拉取数据] --> UpdateLEO[更新 Follower LEO]
    UpdateLEO --> CheckMin[检查 ISR 最小 LEO]

    CheckMin --> MinLEOChanged{最小 LEO 变化?}

    MinLEOChanged -->|是| UpdateHW[更新 HW]
    MinLEOChanged -->|否| NoUpdate[不更新]

    UpdateHW --> Notify[通知 DelayedProduce]
    Notify --> Complete[完成等待的 Produce 请求]

    NoUpdate --> End[结束]
    Complete --> End

    style UpdateHW fill:#f9f,stroke:#333,stroke-width:4px
```scala

```scala
/**
 * 更新 HW 的核心逻辑
 */
private def maybeUpdateHighWatermark(partition: Partition): Unit = {
  val leaderLog = partition.localLogOrException

  // ========== 步骤1: 获取 ISR 所有副本的 LEO ==========
  val isrLEOs = partition.inSyncReplicaIds.map { replicaId =>
    if (replicaId == localBrokerId) {
      // Leader 本身的 LEO
      leaderLog.logEndOffset
    } else {
      // Follower 的 LEO
      partition.followerReplicaLEO(replicaId)
    }
  }

  // ========== 步骤2: 计算新的 HW ==========
  // HW = min(ISR 中所有副本的 LEO)
  val newHighWatermark = isrLEOs.min

  // ========== 步骤3: 检查 HW 是否需要更新 ==========
  val oldHighWatermark = partition.highWatermark
  if (newHighWatermark > oldHighWatermark) {
    // ========== 步骤4: 更新 HW ==========
    leaderLog.updateHighWatermark(newHighWatermark)

    // ========== 步骤5: 完成延迟的 Produce 请求 ==========
    // 等待 HW 推进的请求可以被完成
    delayedProducePurgatory.checkAndComplete(
      topicPartition = partition.topicPartition,
      key = newHighWatermark
    )

    // ========== 步骤6: 持久化 HW ==========
    checkpointHighWatermarks()

    info(
      s"Updated HW for partition ${partition.topicPartition}\n" +
      s"Old HW: $oldHighWatermark, New HW: $newHighWatermark"
    )
  }
}
```text

---

## 3. ISR 扩展与收缩

### 3.1 ISR 调整触发时机
```
ISR 调整触发时机:

1. 定期检查
   ├── 周期: replica.lag.time.max.ms / 2
   ├── 检查: 所有 Leader 分区
   └── 动作: 收缩/扩展 ISR

2. Follower 拉取时
   ├── 触发: 每次 FetchRequest
   ├── 检查: LEO 是否赶上 HW
   └── 动作: 扩展 ISR

3. Follower 故障恢复
   ├── 触发: Follower 重启
   ├── 检查: 是否追上 Leader
   └── 动作: 扩展 ISR

4. 副本重新分配
   ├── 触发: 副本变更
   ├── 检查: 新副本是否追上
   └── 动作: 扩展 ISR
```text

### 3.2 ISR 震荡问题
```
ISR 震荡 (ISR Flapping):

现象:
├── ISR 频繁扩展和收缩
├── 分区状态不稳定
└── 影响:
    ├── 性能下降
    ├── 频繁的元数据更新
    └── 可能的数据不一致

原因:
1. replica.lag.time.max.ms 设置过小
   ├── 网络波动导致频繁移出
   └── 建议: 30000ms (默认)

2. Follower 性能不足
   ├── CPU/磁盘瓶颈
   └── 建议: 升级硬件

3. 网络不稳定
   ├── 延迟/丢包
   └── 建议: 优化网络

解决方案:
// 1. 增加滞后阈值
replica.lag.time.max.ms = 60000

// 2. 增加最小 ISR
min.insync.replicas = 2

// 3. 监控 ISR 变化
isr.shrinks.rate
isr.expands.rate
```text

---

## 4. 数据一致性保障

### 4.1 HW 与数据一致性
```java
/**
 * HW 机制 - 已提交消息的定义
 *
 * 关键约束:
 * HW = min(ISR 中所有副本的 LEO)
 *
 * 推论:
 * 1. HW 之前的消息已被 ISR 所有副本确认
 * 2. 任一副本成为 Leader，都不会丢失这些数据
 * 3. Consumer 只读已提交消息 (≤ HW)
 */

/**
 * HW 与 Exactly-Once 语义
 *
 * 问题: 如何保证消息不丢失、不重复？
 *
 * 答案:
 * 1. Producer:
 *    - 启用幂等性 (enable.idempotence=true)
 *    - ACKS=all (等待 ISR 确认)
 *
 * 2. Broker:
 *    - HW 推进机制
 *    - ISR 管理
 *
 * 3. Consumer:
 *    - Offset 提交到 HW
 *    - 只消费 ≤ HW 的消息
 *
 * 结果: At-Least-Once + 幂等 = Exactly-Once
 */
```bash

### 4.2 HW 与 Consumer 可见性

```java
/**
 * HW 决定 Consumer 可见的消息
 *
 * Consumer Fetch 流程:
 * 1. Consumer 发送 FetchRequest
 * 2. Leader 根据 HW 过滤消息
 * 3. 只返回 offset ≤ HW 的消息
 * 4. 确保 Consumer 读到的是"已提交"的消息
 */

public class Partition {
    /**
     * 读取日志时应用 HW 限制
     */
    public LogReadInfo read(
        long fetchOffset,
        int maxLength,
        FetchIsolation isolation
    ) {
        UnifiedLog log = localLogOrException;

        // ========== 根据隔离级别读取 ==========
        switch (isolation) {
            case FETCH_LOG_END:
                // 读取到 LEO (可能包含未提交数据)
                return log.read(fetchOffset, maxLength);

            case HIGH_WATERMARK:
                // 读取到 HW (只包含已提交数据)
                // 这是默认行为
                long maxOffset = highWatermark;
                return log.read(fetchOffset, maxLength, maxOffset);

            case TRANSACTIONAL:
                // 事务隔离级别
                // 只返回已中止事务之后的数据
                return readTransactionally(fetchOffset, maxLength);
        }
    }
}
```text

---

## 5. 同步性能调优

### 5.1 同步延迟优化
```text
同步延迟优化策略:

1. 网络优化
   ├── 增加拉取字节: replica.fetch.max.bytes
   ├── 减少往返次数: replica.fetch.min.bytes
   └── 压缩数据: compression.type=lz4

2. 磁盘优化
   ├── 使用 SSD
   ├── 增加页面缓存
   └── 调整 flush 策略

3. 线程优化
   ├── 增加拉取线程: num.replica.fetchers
   └── 并行拉取

4. 配置优化
   ├── 减少等待时间: replica.fetch.wait.max.ms
   ├── 增加缓冲区: replica.fetch.max.bytes
   └── 启用增量拉取
```text

### 5.2 配置示例
```properties
# ========== 副本同步配置 ==========

# 拉取线程数
num.replica.fetchers=2

# 单次拉取最大字节
replica.fetch.max.bytes=10485760

# 最小拉取字节
replica.fetch.min.bytes=1

# 最大等待时间
replica.fetch.wait.max.ms=500

# 副本滞后时间阈值
replica.lag.time.max.ms=30000

# 最小同步副本数
min.insync.replicas=2

# 压缩类型
compression.type=lz4
```text

---

## 6. 总结

### 6.1 ISR 机制要点

| 要点 | 说明 |
|-----|------|
| **ISR 定义** | 与 Leader 同步的副本集合 |
| **动态调整** | 慢副本移出, 快副本加入 |
| **HW 计算** | min(ISR 中所有副本的 LEO) |
| **数据一致性** | ≤ HW 的消息已提交 |

### 6.2 最佳实践
```
1. 设置合理的 min.insync.replicas
   └── 推荐: 2 (3 副本集群)

2. 调整 replica.lag.time.max.ms
   └── 默认: 30000ms

3. 监控 ISR 状态
   └── UnderReplicatedPartitions

4. 避免 ISR 震荡
   └── 网络优化, 性能调优

5. 定期检查副本同步
   └── 使用 kafka-check-replica-verification
```

---

**下一步**: [06. 副本操作](./06-replica-operations.md)
