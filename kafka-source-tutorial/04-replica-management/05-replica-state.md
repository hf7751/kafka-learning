# 04. 副本状态机

## 目录
- [1. 副本状态定义](#1-副本状态定义)
- [2. 状态转换规则](#2-状态转换规则)
- [3. Online/Offline 状态](#3-onlineoffline-状态)
- [4. 状态持久化与恢复](#4-状态持久化与恢复)
- [5. 状态转换实战](#5-状态转换实战)

---

## 1. 副本状态定义

### 1.1 副本状态枚举

```scala
/**
 * 副本状态定义
 *
 * Kafka 中副本有多种状态, 反映了副本的当前情况
 */

object ReplicaState {

  /**
   * Online - 在线状态
   *
   * 副本正常运行, 可以提供服务
   */
  case object Online extends ReplicaState {
    override val id: Int = 1
    override val name: String = "Online"
  }

  /**
   * Offline - 离线状态
   *
   * 副本不可用, 无法提供服务
   * 原因:
   * - Broker 下线
   * - 磁盘故障
   * - 网络中断
   */
  case object Offline extends ReplicaState {
    override val id: Int = 2
    override val name: String = "Offline"
  }

  /**
   * Fenced - 被隔离状态
   *
   * 副本被 Controller 隔离
   * 原因:
   * - Leader Epoch 过期
   * - 被移出 ISR
   * - 元数据不一致
   */
  case object Fenced extends ReplicaState {
    override val id: Int = 3
    override val name: String = "Fenced"
  }

  /**
   * Deleting - 删除中状态
   *
   * 副本正在被删除
   */
  case object Deleting extends ReplicaState {
    override val id: Int = 4
    override val name: String = "Deleting"
  }
}
```bash

### 1.2 Leader/Follower 状态

```scala
/**
 * Leader 和 Follower 的子状态
 */

object LeaderState {

  /**
   * Leading - 正在领导
   *
   * 副本是 Leader, 正在处理请求
   */
  case object Leading

  /**
   * Resigning - 正在卸任
   *
   * Leader 正在转换为 Follower
   */
  case object Resigning
}

object FollowerState {

  /**
   * Fetching - 正在拉取
   *
   * Follower 正常从 Leader 拉取数据
   */
  case object Fetching

  /**
   * CatchingUp - 正在追赶
   *
   * Follower 落后，正在追赶 Leader
   * 不在 ISR 中
   */
  case object CatchingUp

  /**
   * Truncating - 正在截断
   *
   * Follower 正在截断日志
   */
  case object Truncating
}
```text

### 1.3 副本状态关系图
```mermaid
graph TB
    subgraph "副本主状态"
        Online[Online 在线]
        Offline[Offline 离线]
        Fenced[Fenced 被隔离]
        Deleting[Deleting 删除中]
    end

    subgraph "Leader 子状态"
        Leading[Leading 正在领导]
        Resigning[Resigning 正在卸任]
    end

    subgraph "Follower 子状态"
        Fetching[Fetching 正在拉取]
        CatchingUp[CatchingUp 正在追赶]
        Truncating[Truncating 正在截断]
    end

    Online --> Leading
    Online --> Fetching
    Leading --> Resigning
    Resigning --> Fetching
    Fetching --> CatchingUp
    CatchingUp --> Fetching

    Online --> Offline
    Offline --> Online
    Online --> Fenced
    Fenced --> Online
    Online --> Deleting
    Deleting --> Offline

    style Online fill:#9f9,stroke:#333,stroke-width:2px
    style Offline fill:#f99,stroke:#333,stroke-width:2px
    style Fenced fill:#ff9,stroke:#333,stroke-width:2px
```text

---

## 2. 状态转换规则

### 2.1 状态转换矩阵
```text
状态转换矩阵:

从 \ 到      │ Online  │ Offline │ Fenced │ Deleting
─────────────────────────────────────────────────────
Online       │   -     │   √     │   √    │    √
Offline      │   √     │   -     │   -    │    -
Fenced       │   √     │   √     │   -    │    √
Deleting     │   -     │   √     │   -    │    √

说明:
√ = 允许转换
- = 不允许转换
```bash

### 2.2 状态转换触发条件

```scala
/**
 * 状态转换触发条件
 */

object StateTransitionTrigger {

  /**
   * Online -> Offline
   *
   * 触发条件:
   * 1. Broker 下线
   * 2. 磁盘故障
   * 3. 网络中断
   * 4. 进程崩溃
   */
  def toOffline(): Unit = {
    // Controller 检测到 Broker 失效
    // 更新元数据
    // 通知其他 Broker
  }

  /**
   * Offline -> Online
   *
   * 触发条件:
   * 1. Broker 恢复上线
   * 2. 磁盘修复
   * 3. 网络恢复
   */
  def toOnline(): Unit = {
    // Broker 启动
    // 加载副本
    // 恢复状态
    // 开始拉取或成为 Leader
  }

  /**
   * Online -> Fenced
   *
   * 触发条件:
   * 1. Leader Epoch 过期
   * 2. 被移出 ISR
   * 3. 元数据不一致
   */
  def toFenced(): Unit = {
    // Controller 隔离副本
    // 副本停止提供服务
    // 等待恢复
  }

  /**
   * Fenced -> Online
   *
   * 触发条件:
   * 1. 元数据同步完成
   * 2. Leader Epoch 更新
   * 3. 重新加入 ISR
   */
  def toOnlineFromFenced(): Unit = {
    // 副本更新状态
    // 重新提供服务
  }

  /**
   * Online -> Deleting
   *
   * 触发条件:
   * 1. 副本重新分配
   * 2. 分区删除
   * 3. Broker 下线迁移
   */
  def toDeleting(): Unit = {
    // Controller 发起删除
    // 副本停止服务
    // 删除日志文件
  }
}
```text

### 2.3 状态转换验证
```scala
/**
 * 状态转换验证
 *
 * 确保状态转换是合法的
 */

class ReplicaStateMachine {
  /**
   * 验证状态转换
   */
  def validateTransition(
    currentState: ReplicaState,
    newState: ReplicaState
  ): Boolean = {

    // ========== 合法的状态转换 ==========
    val validTransitions = Map(
      ReplicaState.Online -> Set(
        ReplicaState.Offline,
        ReplicaState.Fenced,
        ReplicaState.Deleting
      ),
      ReplicaState.Offline -> Set(
        ReplicaState.Online
      ),
      ReplicaState.Fenced -> Set(
        ReplicaState.Online,
        ReplicaState.Offline,
        ReplicaState.Deleting
      ),
      ReplicaState.Deleting -> Set(
        ReplicaState.Offline
      )
    )

    val allowedStates = validTransitions.getOrElse(currentState, Set.empty)
    allowedStates.contains(newState)
  }

  /**
   * 执行状态转换
   */
  def transition(
    replicaId: Int,
    topicPartition: TopicPartition,
    newState: ReplicaState
  ): Unit = {

    // ========== 获取当前状态 ==========
    val currentState = getReplicaState(replicaId, topicPartition)

    // ========== 验证转换 ==========
    if (!validateTransition(currentState, newState)) {
      throw new IllegalStateException(
        s"Illegal state transition: $currentState -> $newState"
      )
    }

    // ========== 执行转换 ==========
    doTransition(replicaId, topicPartition, newState)
  }
}
```scala

---

## 3. Online/Offline 状态

### 3.1 Online 状态详解

```scala
/**
 * Online 状态 - 副本在线
 *
 * 副本可以正常工作
 */

class OnlineReplica(
  val brokerId: Int,
  val topicPartition: TopicPartition
) {

  /**
   * 检查副本是否在线
   */
  def isOnline: Boolean = {
    // 条件:
    // 1. Broker 存活
    // 2. 副本已创建
    // 3. 日志可访问
    // 4. 未被隔离
    true
  }

  /**
   * 成为 Leader
   */
  def becomeLeader(): Unit = {
    require(isOnline, "Replica must be online to become leader")

    // 初始化 Leader 状态
    // 开始处理请求
    // 管理 ISR
  }

  /**
   * 成为 Follower
   */
  def becomeFollower(): Unit = {
    require(isOnline, "Replica must be online to become follower")

    // 初始化 Follower 状态
    // 开始拉取数据
    // 不处理客户端请求
  }
}
```scala

### 3.2 Offline 状态详解

```scala
/**
 * Offline 状态 - 副本离线
 *
 * 副本无法工作
 */

class OfflineReplica(
  val brokerId: Int,
  val topicPartition: TopicPartition
) {

  /**
   * 检查副本是否离线
   */
  def isOffline: Boolean = {
    // 条件:
    // 1. Broker 下线
    // 2. 磁盘故障
    // 3. 网络中断
    // 4. 进程崩溃
    true
  }

  /**
   * 进入离线状态
   */
  def goOffline(): Unit = {
    // ========== 停止提供服务 ==========
    // 停止处理请求
    // 关闭文件句柄
    // 释放资源

    // ========== 更新元数据 ==========
    // 标记为离线
    // 从 ISR 移除
    // 触发 Leader 选举 (如果是 Leader)
  }

  /**
   * 从离线恢复
   */
  def comeOnline(): Unit = {
    // ========== 加载副本 ==========
    // 打开日志文件
    // 恢复状态
    // 初始化 LEO/HW

    // ========== 同步数据 ==========
    // 如果是 Follower, 开始拉取
    // 如果是 Leader, 等待 Controller 选举
  }
}
```bash

### 3.3 状态检测机制

```scala
/**
 * 副本状态检测
 */

class ReplicaStateMonitor(
  replicaManager: ReplicaManager,
  metadataCache: MetadataCache
) {

  /**
   * 检测副本状态
   */
  def detectReplicaState(): Unit = {
    val allReplicas = getAllReplicas()

    allReplicas.foreach { case (brokerId, topicPartition) =>
      val isAlive = isBrokerAlive(brokerId)
      val isDiskHealthy = isDiskHealthy(brokerId)

      // ========== 判断副本状态 ==========
      if (!isAlive || !isDiskHealthy) {
        // 副本离线
        handleReplicaOffline(brokerId, topicPartition)
      } else {
        // 副本在线
        handleReplicaOnline(brokerId, topicPartition)
      }
    }
  }

  /**
   * 检查 Broker 是否存活
   */
  private def isBrokerAlive(brokerId: Int): Boolean = {
    // 通过 SessionTimeout 检测
    metadataCache.getAliveBroker(brokerId).isDefined
  }

  /**
   * 检查磁盘是否健康
   */
  private def isDiskHealthy(brokerId: Int): Boolean = {
    // 检查日志目录是否可用
    replicaManager.logManager.isLogDirectoryAvailable(brokerId)
  }
}
```text

---

## 4. 状态持久化与恢复

### 4.1 检查点文件

```scala
/**
 * 检查点文件 - 持久化副本状态
 *
 * 文件名: replication-offset-checkpoint
 *
 * 格式:
 * ┌──────────────────┬──────────────┐
 * │  Version         │     2        │
 * ├──────────────────┼──────────────┤
 * │  Partition Count │     N        │
 * ├──────────────────┼──────────────┤
 * │  Partition 1     │              │
 * │  ├─ Topic        │  "test"     │
 * │  ├─ Partition    │  0          │
 * │  └─ Offset       │  100        │
 * ├──────────────────┼──────────────┤
 * │  Partition 2     │              │
 * │  ├─ Topic        │  "test"     │
 * │  ├─ Partition    │  1          │
 * │  └─ Offset       │  200        │
 * │     ...          │    ...      │
 * └──────────────────┴──────────────┘
 */

/**
 * 副本偏移量检查点
 */
class ReplicaOffsetCheckpoint(
  file: Path
) extends OffsetCheckpoint {

  /**
   * 保存检查点
   */
  def save(offsets: Map[TopicPartition, Long]): Unit = {
    // ========== 写入临时文件 ==========
    val tempFile = Paths.get(file.toString + ".tmp")

    val writer = Files.newBufferedWriter(tempFile)

    try {
      // ========== 写入版本号 ==========
      writer.write(s"2\n")  // 版本 2

      // ========== 写入分区数 ==========
      writer.write(s"${offsets.size}\n")

      // ========== 写入每个分区的偏移量 ==========
      offsets.foreach { case (tp, offset) =>
        writer.write(s"${tp.topic()} ${tp.partition()} $offset\n")
      }

      writer.flush()

      // ========== 原子性重命名 ==========
      Files.move(tempFile, file, StandardCopyOption.ATOMIC_MOVE)

    } finally {
      writer.close()
    }
  }

  /**
   * 读取检查点
   */
  def read(): Map[TopicPartition, Long] = {
    if (!Files.exists(file)) {
      return Map.empty
    }

    val reader = Files.newBufferedReader(file)
    val offsets = new mutable.HashMap[TopicPartition, Long]()

    try {
      // ========== 读取版本号 ==========
      val version = reader.readLine().toInt

      if (version != 2) {
        throw new IOException(s"Unsupported checkpoint version: $version")
      }

      // ========== 读取分区数 ==========
      val count = reader.readLine().toInt

      // ========== 读取每个分区的偏移量 ==========
      for (_ <- 0 until count) {
        val line = reader.readLine()
        val parts = line.split("\\s+")

        val topic = parts(0)
        val partitionId = parts(1).toInt
        val offset = parts(2).toLong

        val tp = new TopicPartition(topic, partitionId)
        offsets.put(tp, offset)
      }

      offsets.toMap

    } finally {
      reader.close()
    }
  }
}
```bash

### 4.2 HW 检查点

```scala
/**
 * HW (High Watermark) 检查点
 *
 * 持久化 HW 到磁盘
 * 用于崩溃恢复
 */

class HighWatermarkCheckpoint(
  logDir: Path,
  config: KafkaConfig
) {

  private val checkpointFile = logDir.resolve("replication-offset-checkpoint")

  /**
   * 持久化 HW
   */
  def save(hw: Map[TopicPartition, Long]): Unit = {
    val checkpoint = new ReplicaOffsetCheckpoint(checkpointFile)
    checkpoint.save(hw)
  }

  /**
   * 读取 HW
   */
  def read(): Map[TopicPartition, Long] = {
    val checkpoint = new ReplicaOffsetCheckpoint(checkpointFile)
    checkpoint.read()
  }

  /**
   * 定期持久化
   */
  def startPeriodicCheckpoint(): Unit = {
    scheduler.schedule(
      name = "high-watermark-checkpoint",
      fun = () => {
        val hwMap = collectHighWatermarks()
        save(hwMap)
      },
      period = config.replicaHighWatermarkCheckpointIntervalMs,
      unit = TimeUnit.MILLISECONDS
    )
  }
}
```scala

### 4.3 崩溃恢复

```scala
/**
 * 崩溃恢复 - 恢复副本状态
 */

class ReplicaRecovery(
  replicaManager: ReplicaManager,
  logManager: LogManager
) {

  /**
   * 恢复副本状态
   */
  def recoverReplicas(): Unit = {
    // ========== 步骤1: 加载日志 ==========
    val logs = logManager.loadLogs()

    // ========== 步骤2: 恢复 HW ==========
    val hwCheckpoint = new HighWatermarkCheckpoint(logDir, config)
    val hwMap = hwCheckpoint.read()

    logs.foreach { case (tp, log) =>
      val hw = hwMap.getOrElse(tp, 0L)

      // 恢复 HW
      log.updateHighWatermark(hw)

      // ========== 步骤3: 恢复 LEO ==========
      // LEO 从日志文件中恢复
      val leo = log.logEndOffset

      info(
        s"Recovered partition $tp\n" +
        s"HW: $hw, LEO: $leo"
      )
    }

    // ========== 步骤4: 恢复 Leader Epoch ==========
    recoverLeaderEpochs()

    // ========== 步骤5: 恢复 ISR ==========
    // ISR 从 Controller 元数据中恢复
  }

  /**
   * 恢复 Leader Epoch
   */
  private def recoverLeaderEpochs(): Unit = {
    val leaderEpochCheckpoint = new LeaderEpochCheckpoint(logDir)
    val epochs = leaderEpochCheckpoint.read()

    epochs.foreach { case (tp, epochEntry) =>
      val partition = replicaManager.getPartition(tp)
      partition.foreach { p =>
        p.setLeaderEpoch(epochEntry.epoch)
      }
    }
  }
}
```text

---

## 5. 状态转换实战

### 5.1 Broker 启动流程
```mermaid
stateDiagram-v2
    [*] --> BrokerStart: Broker 启动

    BrokerStart --> LoadLogs: 加载日志
    LoadLogs --> RecoverState: 恢复状态
    RecoverState --> RegisterController: 注册到 Controller

    RegisterController --> CheckLeader: 检查是否是 Leader

    CheckLeader --> BecomeLeader: 被选为 Leader
    CheckLeader --> BecomeFollower: 成为 Follower

    BecomeLeader --> Online: 在线
    BecomeFollower --> Online: 在线

    Online --> [*]: 启动完成

    note right of Online
        开始提供服务
        Leader: 处理请求
        Follower: 拉取数据
    end note
```text

### 5.2 Broker 下线流程
```mermaid
stateDiagram-v2
    [*] --> Online: 正常运行

    Online --> ShuttingDown: 收到下线请求

    ShuttingDown --> StopLeader: 停止 Leader
    StopLeader --> TriggerElection: 触发选举

    TriggerElection --> BecomeFollower: 成为 Follower
    BecomeFollower --> StopFetchers: 停止拉取

    StopFetchers --> CloseLogs: 关闭日志
    CloseLogs --> SaveCheckpoint: 持久化检查点

    SaveCheckpoint --> Offline: 离线
    Offline --> [*]: 下线完成

    note right of ShuttingDown
        优雅下线流程:
        1. 停止接受新请求
        2. 等待请求完成
        3. 触发 Leader 选举
        4. 迁移 Leader
        5. 下线
    end note
```bash

### 5.3 故障恢复实战

```text
场景: Broker 故障后恢复

初始状态:
├── Cluster: 3 Broker
├── Topic: test (3 副本)
├── Partition 0: [Broker-1, Broker-2, Broker-3]
├── Leader: Broker-1
└── ISR: [1, 2, 3]

T1: Broker-1 故障
    ├── Controller 检测到故障
    ├── 从 ISR [2, 3] 中选举新 Leader
    └── Broker-2 成为 Leader

T2: Broker-1 恢复
    ├── 启动 Broker-1
    ├── 加载日志
    ├── 恢复 HW
    └── 向 Controller 注册

T3: Broker-1 成为 Follower
    ├── 接收新 Leader (Broker-2)
    ├── 比较 Leader Epoch
    ├── 截断日志 (如果需要)
    └── 开始从 Broker-2 拉取

T4: Broker-1 追上 Leader
    ├── LEO >= Old HW
    ├── 重新加入 ISR
    └── ISR: [1, 2, 3]

验证:
kafka-metadata-shell --snapshot <metadata-quorum.properties> \
  --csv-select-record Partition:test:0

输出:
partition: test:0
leader: 2
isr: [1, 2, 3]
replicas: [1, 2, 3]```

---

## 6. 总结

### 6.1 副本状态要点

| 状态 | 说明 | 触发条件 |
|-----|------|---------|
| **Online** | 在线, 可服务 | Broker 正常运行 |
| **Offline** | 离线, 不可用 | Broker 故障 |
| **Fenced** | 被隔离 | Epoch 过期 |
| **Deleting** | 删除中 | 副本删除 |

### 6.2 状态管理最佳实践

```text
1. 定期检查副本状态
   └── 监控 Offline 副本数

2. 及时处理故障
   └── 快速恢复 Broker

3. 优雅下线
   └── 使用 kafka-stop-shutdown

4. 定期备份检查点
   └── 防止数据丢失

5. 监控状态转换
   └── 异常转换需要告警```

---

**下一步**: [05. 副本同步与 ISR](./05-replica-sync.md)
