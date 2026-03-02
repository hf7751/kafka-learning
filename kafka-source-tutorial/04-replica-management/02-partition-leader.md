# 02. 分区 Leader 选举

## 目录
- [1. Leader 选举概述](#1-leader-选举概述)
- [2. 选举触发条件](#2-选举触发条件)
- [3. 选举流程](#3-选举流程)
- [4. Unclean Leader 选举](#4-unclean-leader-选举)
- [5. Leader Epoch 机制](#5-leader-epoch-机制)
- [6. 选举实战案例](#6-选举实战案例)

---

## 1. Leader 选举概述

### 1.1 选举的重要性

```text
Leader 选举的核心目标:

1. 高可用性 (High Availability)
   ├── Leader 故障时快速切换
   ├── 最小化服务中断时间
   └── 保证持续提供服务

2. 数据一致性 (Data Consistency)
   ├── 新 Leader 有所有已提交数据
   ├── 避免数据丢失
   └── 避免数据冲突

3. 负载均衡 (Load Balancing)
   ├── Leader 分布在不同 Broker
   ├── 避免热点
   └── 优化集群性能
```text

### 1.2 选举类型
```scala
/**
 * Leader 选举类型
 */

object LeaderElectionType {
  // 1. Controller 触发的选举
  //    - 分区创建时
  //    - 优先副本选举
  //    - 副本重新分配
  val ControllerTriggered = 1

  // 2. Broker 触发的选举
  //    - Leader 故障检测
  //    - 自动选举
  val BrokerTriggered = 2

  // 3. Admin 触发的选举
  //    - 手动触发
  //    - 管理员干预
  val AdminTriggered = 3
}
```bash

### 1.3 选举参与者

```mermaid
graph TB
    Controller[Controller] -->|发起选举| Partition[Partition]
    Broker1[Broker 1<br/>Candidate] -->|参与选举| Partition
    Broker2[Broker 2<br/>ISR Member] -->|参与选举| Partition
    Broker3[Broker 3<br/>ISR Member] -->|参与选举| Partition

    Partition -->|选择| NewLeader[新 Leader]

    Controller -->|通知| ZK[Metadata Log]
    ZK -->|持久化| LeaderInfo[Leader 信息]

    Controller -->|广播| AllBrokers[所有 Broker]

    NewLeader -->|开始服务| Clients[Producer/Consumer]

    style Controller fill:#f9f,stroke:#333,stroke-width:4px
    style NewLeader fill:#9f9,stroke:#333,stroke-width:4px
```scala

---

## 2. 选举触发条件

### 2.1 Controller 触发选举

```scala
/**
 * Controller 触发的选举场景
 */

object LeaderElectionTrigger {

  // 1. 分区创建时
  def onPartitionCreated(topic: String, partitionId: Int): Unit = {
    // 选择 AR 中的第一个副本作为 Leader
    val assignedReplicas = replicaAssignment(topic, partitionId)
    val leader = assignedReplicas.head

    electLeader(
      topicPartition = new TopicPartition(topic, partitionId),
      newLeader = leader,
      leaderEpoch = epoch
    )
  }

  // 2. 优先副本选举
  //    - 将 Leader 迁移到优先副本 (AR[0])
  //    - 用于负载均衡
  def onPreferredReplicaElection(partitions: Set[TopicPartition]): Unit = {
    partitions.foreach { tp =>
      val assignedReplicas = replicaAssignment(tp)
      val preferredReplica = assignedReplicas.head

      if (currentLeader(tp) != preferredReplica) {
        // 触发选举, 迁移到优先副本
        electLeader(tp, preferredReplica)
      }
    }
  }

  // 3. 副本重新分配
  def onPartitionReassignment(tp: TopicPartition,
                             newAssignment: Seq[Int]): Unit = {
    // 根据新分配方案选择 Leader
    // 优先选择新 AR 中仍在新 ISR 里的副本
    val currentISR = partitionISR(tp)
    val newLeader = newAssignment.find(currentISR.contains).getOrElse(
      newAssignment.head
    )

    electLeader(tp, newLeader)
  }
}
```bash

### 2.2 Broker 故障触发

```scala
/**
 * Broker 故障检测与选举
 */

class Controller {
  // ========== Broker 监控 ==========
  val brokerWatcher = new BrokerWatcher()

  /**
   * 检测到 Broker 下线
   */
  def onBrokerFailure(deadBrokerId: Int): Unit = {
    info(s"Broker $deadBrokerId has been shutdown")

    // ========== 步骤1: 找到该 Broker 上的所有 Leader 分区 ==========
    val leaderPartitionsOnDeadBroker = allPartitions.filter { case (tp, assignment) =>
      assignment.leader == deadBrokerId
    }.keys

    // ========== 步骤2: 对每个分区发起新的选举 ==========
    leaderPartitionsOnDeadBroker.foreach { tp =>
      electNewLeader(tp)
    }
  }

  /**
   * 选举新 Leader
   */
  def electNewLeader(tp: TopicPartition): Unit = {
    val partition = getPartition(tp)
    val assignment = partition.replicaAssignment
    val isr = partition.inSyncReplicaIds

    // ========== 步骤3: 从 ISR 中选择新 Leader ==========
    // 策略: 选择 AR 中排在最前面的 ISR 副本
    val newLeaderOpt = assignment.replicas.find(isr.contains)

    newLeaderOpt match {
      case Some(newLeader) =>
        // 找到合适的新 Leader
        info(s"Selected new leader $newLeader for partition $tp")
        makeLeader(tp, newLeader)

      case None =>
        // ISR 中没有可用副本
        // 根据 unclean.leader.election.enable 决定是否允许 OSR 成为 Leader
        if (config.uncleanLeaderElectionEnabled) {
          val newLeader = assignment.replicas.head
          warn(s"Unclean leader election for partition $tp, new leader: $newLeader")
          makeLeader(tp, newLeader)
        } else {
          error(s"No ISR replica available for partition $tp, unclean election disabled")
          // 分区不可用, 等待 ISR 恢复
        }
    }
  }
}
```scala

### 2.3 网络分区触发

```scala
/**
 * 网络分区导致的选举
 *
 * 场景: ISR 中副本无法与 Leader 通信
 */

class ReplicaManager {
  /**
   * 检测 Leader 是否失效
   */
  def checkLeaderFailure(): Unit = {
    leaderPartitionsIterator.foreach { partition =>
      val currentLeader = partition.leaderReplicaIdOpt

      // ========== 检查 Leader 是否存活 ==========
      // 1. 检查 Leader Epoch 是否过期
      // 2. 检查 Leader 是否还在 ISR 中
      // 3. 检查是否收到 Controller 的 Leader 变更通知

      if (isLeaderExpired(partition)) {
        // Leader 已过期, 触发选举
        info(s"Leader $currentLeader for partition ${partition.topicPartition} is expired")
        requestLeaderElection(partition.topicPartition)
      }
    }
  }

  /**
   * 判断 Leader 是否过期
   */
  private def isLeaderExpired(partition: Partition): Boolean = {
    // 检查 Leader Epoch
    val currentLeaderEpoch = partition.leaderEpoch
    val expectedLeaderEpoch = controllerContext.epochFor(partition.topicPartition)

    currentLeaderEpoch < expectedLeaderEpoch
  }
}
```mermaid

---

## 3. 选举流程

### 3.1 选举流程图

```mermaid
sequenceDiagram
    participant Controller as Controller
    participant ISR as ISR 副本集合
    participant Candidate as 候选 Leader
    participant Metadata as Metadata Log
    participant Brokers as 所有 Broker

    Controller->>Controller: 检测到 Leader 失效

    Controller->>ISR: 检查 ISR 状态
    ISR-->>Controller: 返回 ISR 列表

    Controller->>Controller: 选择新 Leader
    Note over Controller: 策略: AR ∩ ISR 中优先级最高的

    Controller->>Candidate: 选举为新 Leader
    activate Candidate

    Candidate->>Candidate: makeLeader()
    Candidate->>Candidate: 初始化 Leader Epoch
    Candidate->>Candidate: 加载 HW

    Candidate-->>Controller: 成为 Leader 成功
    deactivate Candidate

    Controller->>Metadata: 持久化 Leader 信息
    Metadata-->>Controller: 写入成功

    Controller->>Brokers: 广播 Leader 变更
    Brokers-->>Controller: 确认

    Controller->>Controller: 更新元数据缓存

    Brokers->>Candidate: 开始同步
    Note over Candidate: 开始接受读写请求

    style Controller fill:#f9f,stroke:#333,stroke-width:4px
    style Candidate fill:#9f9,stroke:#333,stroke-width:4px
```scala

### 3.2 选举算法

```scala
/**
 * Partition Leader 选举算法
 */

object LeaderElectionAlgorithm {

  /**
   * 选择新 Leader
   *
   * 策略:
   * 1. 优先选择 AR (Assigned Replica) 中排在最前面的副本
   * 2. 必须在 ISR 中 (除非允许 Unclean 选举)
   * 3. 必须在线
   */
  def selectNewLeader(
    partition: Partition,
    uncleanElectionEnabled: Boolean
  ): Option[Int] = {

    val assignedReplicas = partition.replicaAssignment.replicas
    val isr = partition.inSyncReplicaIds
    val aliveBrokers = controllerContext.liveBrokerIds

    // ========== 策略 1: 从 ISR 中选择 ==========
    // 选择 AR ∩ ISR 中优先级最高的
    val isrLeader = assignedReplicas.find { replicaId =>
      isr.contains(replicaId) && aliveBrokers.contains(replicaId)
    }

    if (isrLeader.isDefined) {
      info(s"Selected leader ${isrLeader.get} from ISR for partition ${partition.topicPartition}")
      return isrLeader
    }

    // ========== 策略 2: Unclean 选举 ==========
    // 如果允许，从 AR 中选择第一个在线副本
    if (uncleanElectionEnabled) {
      val arLeader = assignedReplicas.find(aliveBrokers.contains)

      if (arLeader.isDefined) {
        warn(s"Unclean election: selected leader ${arLeader.get} from AR for partition ${partition.topicPartition}")
        return arLeader
      }
    }

    // ========== 策略 3: 无可用 Leader ==========
    error(s"No available leader for partition ${partition.topicPartition}")
    None
  }
}
```bash

### 3.3 Partition.makeLeader()

```scala
/**
 * Partition.makeLeader() - 成为 Leader
 *
 * 被选为 Leader 后的初始化流程
 */
def makeLeader(
  controllerEpoch: Int,
  partitionLeaderEpoch: Int,
  isNewLeader: Boolean
): Boolean = {
  // ========== 步骤1: 更新 Leader Epoch ==========
  if (leaderEpoch >= partitionLeaderEpoch) {
    info(s"Leader ${localBrokerId} is already the leader for partition $topicPartition " +
         s"with epoch $leaderEpoch, ignoring request with epoch $partitionLeaderEpoch")
    return false
  }

  leaderEpoch = partitionLeaderEpoch

  // ========== 步骤2: 初始化 Leader 副本 ==========
  val leaderReplica = localReplica()
  if (leaderReplica.isDefined) {
    leaderReplica.get.convertToLeaderIfLocal()
  }

  // ========== 步骤3: 初始化 HW ==========
  // 从 Leader Epoch 文件中恢复 HW
  val hw = logManager.highWatermark(topicPartition)
  if (hw.isPresent) {
    log.updateHighWatermark(hw.get())
  } else {
    // 如果没有 HW, 从 LEO 开始
    log.updateHighWatermark(log.logEndOffset)
  }

  // ========== 步骤4: 清空延迟操作 ==========
  // 移除 DelayedProducePurgatory 中等待的请求
  replicaManager.delayedProducePurgatory.checkAndComplete(topicPartition)

  // ========== 步骤5: 标记为可提供服务的 Leader ==========
  // 开始接受 Produce/Fetch 请求

  stateChangeLogger.info(
    s"Completed leader transition for partition $topicPartition\n" +
    s"Leader epoch: $partitionLeaderEpoch\n" +
    s"ISR: ${inSyncReplicaIds.mkString(",")}\n" +
    s"HW: $highWatermark"
  )

  true
}
```

### 3.4 Partition.makeFollower()

```scala
/**
 * Partition.makeFollower() - 成为 Follower
 *
 * 不再是 Leader 后转为 Follower
 */
def makeFollower(
  controllerEpoch: Int,
  partitionLeaderEpoch: Int,
  newLeaderBrokerId: Int,
  isNewLeader: Boolean
): Boolean = {
  // ========== 步骤1: 检查 Leader Epoch ==========
  if (leaderEpoch >= partitionLeaderEpoch) {
    info(s"Broker $localBrokerId is already a follower for partition $topicPartition " +
         s"with epoch $leaderEpoch, ignoring request with epoch $partitionLeaderEpoch")
    return false
  }

  leaderEpoch = partitionLeaderEpoch

  // ========== 步骤2: 更新状态 ==========
  stateChangeLogger.info(
    s"Adding follower for partition $topicPartition\n" +
    s"Current leader epoch: $leaderEpoch\n" +
    s"New leader: $newLeaderBrokerId"
  )

  // ========== 步骤3: 初始化 Follower 副本 ==========
  val followerReplica = localReplica()
  if (followerReplica.isDefined) {
    followerReplica.get.convertToFollowerIfLocal()
  }

  // ========== 步骤4: 开始从 Leader 拉取数据 ==========
  // ReplicaFetcherManager 会处理
  replicaManager.replicaFetcherManager.addFetcherForPartitions(
    Set(topicPartition)
  )

  // ========== 步骤5: 清空未确认的消息 ==========
  // 移除 DelayedProducePurgatory 中等待的请求
  replicaManager.delayedProducePurgatory.checkAndComplete(topicPartition)

  stateChangeLogger.info(
    s"Completed follower transition for partition $topicPartition\n" +
    s"Leader epoch: $partitionLeaderEpoch\n" +
    s"Leader: $newLeaderBrokerId"
  )

  true
}
```

---

## 4. Unclean Leader 选举

### 4.1 什么是 Unclean 选举

```
Unclean Leader 选举定义:

正常选举 (Clean Election):
├── 从 ISR 中选择新 Leader
├── 新 Leader 有所有已提交数据
└── 保证数据一致性

Unclean 选举:
├── ISR 中没有可用副本
├── 从 OSR (Out-of-Sync Replicas) 中选择
├── 新 Leader 可能缺少数据
└── 可能导致:
    ├── 数据丢失 (未确认数据)
    ├── 数据冲突 (Consumer 重复消费)
    └── 一致性问题
```bash

### 4.2 Unclean 选举触发条件

```scala
/**
 * Unclean 选举条件
 */

object UncleanLeaderElection {

  /**
   * 检查是否需要 Unclean 选举
   */
  def shouldTriggerUncleanElection(
    partition: Partition,
    config: KafkaConfig
  ): Boolean = {

    // ========== 条件 1: 配置允许 ==========
    if (!config.uncleanLeaderElectionEnable) {
      info(s"Unclean leader election is disabled for partition ${partition.topicPartition}")
      return false
    }

    // ========== 条件 2: ISR 中没有可用副本 ==========
    val isr = partition.inSyncReplicaIds
    val aliveBrokers = controllerContext.liveBrokerIds
    val availableISR = isr.filter(aliveBrokers.contains)

    if (availableISR.nonEmpty) {
      // ISR 中还有可用副本, 不需要 Unclean 选举
      return false
    }

    // ========== 条件 3: AR 中有可用副本 ==========
    val assignedReplicas = partition.replicaAssignment.replicas
    val availableAR = assignedReplicas.filter(aliveBrokers.contains)

    if (availableAR.isEmpty) {
      // 所有副本都不可用, 无法选举
      error(s"No available replicas for partition ${partition.topicPartition}")
      return false
    }

    // ========== 满足所有条件, 触发 Unclean 选举 ==========
    warn(s"Triggering unclean leader election for partition ${partition.topicPartition}")
    true
  }
}
```scala

### 4.3 Unclean 选举流程

```scala
/**
 * Unclean 选举实现
 */

def electUncleanLeader(partition: Partition): Option[Int] = {
  val assignedReplicas = partition.replicaAssignment.replicas
  val aliveBrokers = controllerContext.liveBrokerIds

  // ========== 步骤1: 从 AR 中选择第一个在线副本 ==========
  val newLeader = assignedReplicas.find(aliveBrokers.contains)

  newLeader match {
    case Some(leaderId) =>
      // ========== 步骤2: 选举新 Leader ==========
      warn(
        s"Unclean leader election for partition ${partition.topicPartition}\n" +
        s"New leader: $leaderId (not in ISR)\n" +
        s"ISR: ${partition.inSyncReplicaIds.mkString(",")}\n" +
        s"Data loss is possible!"
      )

      // ========== 步骤3: 记录 Unclean 选举指标 ==========
      uncleanLeaderElectionEnabled.mark()

      Some(leaderId)

    case None =>
      // ========== 步骤4: 无可用副本 ==========
      error(s"No available replicas for unclean election of partition ${partition.topicPartition}")
      None
  }
}
```bash

### 4.4 Unclean 选举的影响

```text
Unclean 选举的影响:

数据丢失:
├── 旧 Leader 有未确认数据
├── 新 Leader (OSR) 没有这些数据
└── 结果: 永久丢失

数据冲突:
├── Consumer 已读取部分未确认数据
├── 新 Leader 没有这些数据
└── 结果: Consumer 重复消费

一致性问题:
├── HW 回退
├── 已提交数据可能丢失
└── 违反一致性保证

示例:

时间线:
T1: Producer 发送 M1, M2, M3 (acks=all)
T2: Leader 确认 M1, M2 (HW=2)
T3: Leader 写入 M3 (未确认, HW=2)
T4: Leader 故障
T5: Unclean 选举, OSR 成为新 Leader
T6: 新 Leader HW=0 (M1, M2, M3 都丢失!)
```bash

### 4.5 配置建议

```text
unclean.leader.election.enable 配置建议:

| 配置项 | 默认值 | 说明 |
|-------|-------|------|
| unclean.leader.election.enable | false | 是否允许非 ISR 副本成为 Leader |

默认值: false (不启用)

适用场景:

启用 (true):
├── 测试环境
├── 数据可丢失的场景
├── 优先保证可用性
└── 灾难恢复 (最后手段)

禁用 (false): [推荐]
├── 生产环境
├── 数据一致性要求高
├── 金融/支付场景
└── 宁可不可用, 不丢数据

替代方案:
├── 增加副本数 (降低 ISR 全故障概率)
├── 使用 min.insync.replicas > 1
├── 多机房部署
└── 及时修复故障 Broker```

---

## 5. Leader Epoch 机制

### 5.1 Leader Epoch 概述

```scala
/**
 * Leader Epoch - Leader 的版本号
 *
 * 作用:
 * 1. 识别过期的 Leader
 * 2. 防止"脑裂" (Split-Brain)
 * 3. 保证数据一致性
 * 4. 确定日志截断位置
 *
 * 示例:
 * Leader Epoch 0: Broker-A 是 Leader
 * Leader Epoch 1: Broker-B 是 Leader (A 故障)
 * Leader Epoch 2: Broker-A 是 Leader (B 故障, A 恢复)
 *
 * 如果 Epoch 2 的 Leader 收到 Epoch 1 的请求
 * → 识别为过期 Leader
 * → 拒绝请求
 * → 避免数据不一致
 */
```

### 5.2 Leader Epoch 文件

```scala
/**
 * Leader Epoch 文件格式
 *
 * 文件名: leader-epoch-checkpoint
 *
 * 格式:
 * ┌──────────────┬──────────────┐
 * │ Leader Epoch │  End Offset  │
 * ├──────────────┼──────────────┤
 * │      0       │    100       │  Epoch 0 的最后 Offset
 * │      1       │    200       │  Epoch 1 的最后 Offset
 * │      2       │    350       │  Epoch 2 的最后 Offset
 * │     ...      │    ...       │
 * └──────────────┴──────────────┘
 *
 * 用途:
 * - 崩溃恢复时确定截断位置
 * - 判断 Leader 是否过期
 * - 解决数据不一致
 */

case class LeaderEpochEntry(
  epoch: Int,        // Leader Epoch 编号
  startOffset: Long  // 该 Epoch 起始 Offset
)

/**
 * Leader Epoch Cache
 */
class LeaderEpochFile {
  private val epochs = new ConcurrentHashMap[Int, Long]()

  /**
   * 添加新的 Epoch
   */
  def assign(epoch: Int, offset: Long): Unit = {
    epochs.put(epoch, offset)
    flush()
  }

  /**
   * 查找 Offset 对应的 Epoch
   */
  def epochFor(offset: Long): Int = {
    epochs.entrySet()
      .filter(_.getValue <= offset)
      .maxBy(_.getKey)
      .getKey
  }

  /**
   * 查找 Epoch 对应的结束 Offset
   */
  def endOffsetFor(epoch: Int): Option[Long] = {
    // 查找下一个 Epoch 的起始 Offset
    val nextEpoch = epochs.keySet().filter(_ > epoch).minOption
    nextEpoch.map(epochs.get)
  }
}
```bash

### 5.3 Leader Epoch 在选举中的应用

```scala
/**
 * Leader Epoch 在选举中的应用
 */

class Partition {
  /**
   * 检查 Leader Epoch 是否有效
   */
  def validateLeaderEpoch(requestEpoch: Int): Boolean = {
    val currentEpoch = leaderEpoch

    if (requestEpoch < currentEpoch) {
      // 请求的 Epoch 过期
      warn(
        s"Received request with stale epoch $requestEpoch " +
        s"for partition $topicPartition (current epoch: $currentEpoch)"
      )
      return false
    }

    if (requestEpoch > currentEpoch) {
      // 请求的 Epoch 更新，可能是新的 Leader
      info(
        s"Received request with newer epoch $requestEpoch " +
        s"for partition $topicPartition (current epoch: $currentEpoch)"
      )
    }

    true
  }
}
```scala

### 5.4 Leader Epoch 与日志截断

```scala
/**
 * Leader Epoch 用于日志截断
 *
 * 场景: Follower 恢复后需要截断日志
 */

class ReplicaFetcherThread {
  /**
   * Follower 启动时的截断流程
   */
  private def truncateOnFetch(): Unit = {
    val partition = replicaMgr.getPartition(topicPartition)

    // ========== 步骤1: 发送 OffsetForLeaderEpochRequest ==========
    val request = new OffsetForLeaderEpochRequest(
      partitions = Map(topicPartition -> new LeaderEpochOffset())
    )

    val response = fetchFromLeader(request)

    // ========== 步骤2: 获取 Leader 的 Epoch 和 Offset ==========
    val leaderEpoch = response.leaderEpoch(topicPartition)
    val leaderEndOffset = response.endOffset(topicPartition)

    // ========== 步骤3: 截断到该 Epoch 的结束 Offset ==========
    partition match {
      case Some(p) =>
        val localLog = p.localLogOrException
        val truncationOffset = localLog.truncationOffsetFor(leaderEpoch)

        if (truncationOffset.isPresent && localLog.logEndOffset > truncationOffset.get()) {
          info(
            s"Truncating partition $topicPartition to offset $truncationOffset " +
            s"(leader epoch: $leaderEpoch)"
          )

          // 截断日志
          localLog.truncateTo(truncationOffset.get())
        }

      case None =>
        error(s"Partition $topicPartition not found")
    }
  }
}
```text

---

## 6. 选举实战案例

### 6.1 案例 1: Broker 故障选举
```text
场景: 3 副本集群, Broker 1 故障

初始状态:
├── Topic: test-partition-0
├── AR: [1, 2, 3]
├── Leader: Broker 1
└── ISR: [1, 2, 3]

T1: Broker 1 故障
T2: Controller 检测到故障
T3: 从 ISR [2, 3] 中选择新 Leader
    ├── 选择策略: AR 中优先级最高的
    └── 结果: Broker 2 成为新 Leader
T4: 更新元数据
T5: 广播到所有 Broker
T6: Broker 3 开始从 Broker 2 同步

最终状态:
├── Leader: Broker 2
├── ISR: [2, 3]
└── 数据: 无丢失 (Broker 1 的未确认数据除外)

验证命令:
kafka-leader-election.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --partition 0 \
  --election-type PREFERRED
```bash

### 6.2 案例 2: ISR 全故障选举

```text
场景: ISR 中所有副本故障, 需要 Unclean 选举

初始状态:
├── Topic: test-partition-0
├── AR: [1, 2, 3]
├── Leader: Broker 1
└── ISR: [1, 2]

T1: Broker 1 和 Broker 2 同时故障
T2: ISR: []
T3: Controller 检测到 ISR 为空
T4: 检查 unclean.leader.election.enable
    ├── 如果 = false: 分区不可用
    └── 如果 = true: 从 OSR 选择 Leader
T5: 选择 Broker 3 (OSR) 成为 Leader
T6: HW 回退到 0
T7: 可能丢失数据

恢复后:
├── Broker 1 恢复
├── Broker 1 成为 Follower
├── 截断日志到 Broker 3 的 HW
└── 丢失未确认数据

避免方法:
├── 增加副本数 (5 副本)
├── 设置 min.insync.replicas > 1
├── 多机房部署
└── 禁用 unclean 选举```bash

### 6.3 案例 3: 优先副本选举

```text
场景: 负载不均衡, 需要迁移到优先副本

初始状态:
├── Topic: test-partition-0
├── AR: [1, 2, 3]  (1 是优先副本)
├── Leader: Broker 2 (非优先)
└── ISR: [2, 3]

问题: Broker 2 负载过高

解决方案: 优先副本选举

步骤:
1. 生成选举文件
cat > preferred-replica-election.json <<EOF
{
  "partitions": [
    {
      "topic": "test",
      "partition": 0
    }
  ]
}
EOF

2. 执行选举
kafka-preferred-replica-election.sh \
  --bootstrap-server localhost:9092 \
  --path-to-json-file preferred-replica-election.json

3. 验证
kafka-metadata-shell --snapshot <metadata-quorum.properties> \
  --csv-select-record Partition:test:0

结果:
├── Leader: Broker 1 (优先副本)
├── ISR: [1, 2, 3]
└── 负载: 更均衡

最佳实践:
├── 定期执行优先副本选举
├── 在低峰期执行
└── 监控 Leader 分布
```bash

### 6.4 案例 4: 手动 Leader 选举

```text
场景: 需要手动指定 Leader

使用场景:
├── 维护窗口
├── 性能优化
└── 故障恢复

KIP-631 (新版本):
kafka-leader-election.sh \
  --bootstrap-server localhost:9092 \
  --topic test \
  --partition 0 \
  --election-type UNCLEAN \
  --leader 3

指定 Leader 为 Broker 3```

---

## 7. 总结

### 7.1 Leader 选举要点

| 要点 | 说明 |
|-----|------|
| **选举目标** | 高可用 + 数据一致性 |
| **选举策略** | AR ∩ ISR 中优先级最高 |
| **Unclean 选举** | 可能丢失数据, 生产环境禁用 |
| **Leader Epoch** | 防止脑裂, 保证一致性 |
| **快速切换** | 通常秒级完成 |

### 7.2 最佳实践

```text
1. 合理配置副本数
   └── 推荐 3 副本或 5 副本

2. 禁用 Unclean 选举
   └── unclean.leader.election.enable=false

3. 定期执行优先副本选举
   └── 保持负载均衡

4. 监控选举频率
   └── 频繁选举说明有问题

5. 监控 ISR 状态
   └── 确保 ISR 健康```

---

**下一步**: [03. 副本拉取机制](./03-replica-fetcher.md)
