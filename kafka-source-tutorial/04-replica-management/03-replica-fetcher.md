# 03. 副本拉取机制

## 目录
- [1. 拉取架构概览](#1-拉取架构概览)
- [2. ReplicaFetcherThread](#2-replicafetcherthread)
- [3. 拉取请求构建](#3-拉取请求构建)
- [4. 响应处理流程](#4-响应处理流程)
- [5. 拉取性能优化](#5-拉取性能优化)
- [6. 故障处理与重试](#6-故障处理与重试)

---

## 1. 拉取架构概览

### 1.1 副本同步架构

```properties
副本同步架构:

┌─────────────────────────────────────────────────────────────┐
│  Leader Broker                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Partition (Leader)                                  │   │
│  │  ├── Log (本地日志)                                   │   │
│  │  ├── RemoteReplicas (追踪所有 Follower)               │   │
│  │  │   ├── Follower 1: LEO=100, lastFetch=T1           │   │
│  │  │   ├── Follower 2: LEO=95,  lastFetch=T2           │   │
│  │  │   └── Follower 3: LEO=0,   lastFetch=T3           │   │
│  │  └── HW Manager                                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↑│                               │
│                    FetchRequest                            │
│                           │↓                               │
│                    FetchResponse                           │
└─────────────────────────────────────────────────────────────┘
                           ↑│
                    FetchRequest
                           │↓
                    FetchResponse
┌─────────────────────────────────────────────────────────────┐
│  Follower Broker                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ReplicaFetcherThread (拉取线程)                      │   │
│  │  ├──FetchRequest Builder (构建请求)                   │   │
│  │  ├── Network Client (网络通信)                        │   │
│  │  └── Response Processor (处理响应)                    │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Partition (Follower)                                │   │
│  │  ├── Log (本地日志)                                   │   │
│  │  └── LEO Tracker                                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```bash

### 1.2 拉取线程模型

```scala
/**
 * ReplicaFetcherManager - 副本拉取管理器
 *
 * 管理所有 ReplicaFetcherThread
 * 每个 Leader Broker 对应一个拉取线程
 */

class ReplicaFetcherManager(
  val config: KafkaConfig,
  replicaMgr: ReplicaManager,
  ...
) extends AbstractFetcherManager {

  /**
   * 创建拉取线程
   */
  override def createFetcherThread(
    fetcherId: Int,
    sourceBroker: BrokerEndPoint
  ): AbstractFetcherThread = {

    // 每个 Leader Broker 对应一个拉取线程
    // 一个线程可以拉取多个分区
    val threadName = s"ReplicaFetcherThread-$fetcherId-${sourceBroker.id}"

    new ReplicaFetcherThread(
      name = threadName,
      fetcherId = fetcherId,
      brokerConfig = config,
      sourceBroker = sourceBroker,
      replicaMgr = replicaMgr,
      ...
    )
  }

  /**
   * 添加分区到拉取线程
   */
  def addFetcherForPartitions(partitions: Set[TopicPartition]): Unit = {
    // 按 Leader Broker 分组
    val partitionsPerLeader = partitions.groupBy { tp =>
      metadataCache.getAliveLeader(tp).broker
    }

    // 为每个 Leader 分配到对应的拉取线程
    partitionsPerLeader.foreach { case (leaderBroker, partitions) =>
      val fetcherThread = getFetcherThread(leaderBroker.id)
      fetcherThread.addPartitions(partitions)
    }
  }
}
```mermaid

### 1.3 拉取流程图

```mermaid
sequenceDiagram
    participant Follower as Follower Broker
    participant Thread as FetcherThread
    participant Builder as Request Builder
    participant Network as Network Client
    participant Leader as Leader Broker

    Follower->>Thread: 启动拉取线程
    Thread->>Thread: doWork() 循环

    Thread->>Builder: 构建 FetchRequest
    Builder->>Builder: 选择分区
    Builder->>Builder: 确定拉取 Offset
    Builder-->>Thread: FetchRequest

    Thread->>Network: 发送请求
    Network->>Leader: FetchRequest
    Leader->>Leader: 读取日志
    Leader->>Leader: 应用 HW 限制
    Leader-->>Network: FetchResponse
    Network-->>Thread: FetchResponse

    Thread->>Thread: 处理响应
    Thread->>Follower: 写入本地日志
    Thread->>Thread: 更新 LEO
    Thread->>Leader: 下次拉取 (上报 LEO)

    Note over Thread,Leader: 循环拉取
```scala

---

## 2. ReplicaFetcherThread

### 2.1 线程核心结构

```scala
/**
 * ReplicaFetcherThread - Follower 拉取线程
 *
 * 每个 Follower 副本有一个专门的拉取线程
 * 从 Leader 拉取数据并写入本地日志
 */
class ReplicaFetcherThread(
  name: String,
  fetcherId: Int,
  brokerConfig: KafkaConfig,
  sourceBroker: BrokerEndPoint,
  replicaMgr: ReplicaManager,
  metrics: Metrics,
  time: Time,
  ...
) extends AbstractFetcherThread(
  name = name,
  clientId = name,
  sourceBroker = sourceBroker,
  fetcherId = fetcherId,
  maxLag = brokerConfig.replicaFetchWaitMaxMs,
  minBytes = brokerConfig.replicaFetchMinBytes,
  ...
) {

  // ========== 网络客户端 ==========
  private val networkClient = {
    val selector = Selector(
      ...,
      time = time,
      metricLabels = Map("broker-id" -> sourceBroker.id.toString)
    )
    new NetworkClient(
      selector = selector,
      ...
    )
  }

  // ========== 指标 ==========
  private val bytesPerSec = metrics.metricName("fetch-rate-avg", metricGroup)
  private val requestsPerSec = metrics.metricName("requests-sec", metricGroup)

  /**
   * 核心拉取循环
   */
  override def doWork(): Unit = {
    // ========== 步骤1: 构建 FetchRequest ==========
    val fetchRequest = buildFetchRequest()

    // ========== 步骤2: 发送到 Leader ==========
    val fetchResponse = fetchFromLeader(fetchRequest)

    // ========== 步骤3: 处理 FetchResponse ==========
    if (fetchResponse != null) {
      processPartitionResponse(fetchResponse)
    }

    // ========== 步骤4: 更新指标 ==========
    updateMetrics()
  }

  /**
   * 发送 FetchRequest 到 Leader
   */
  private def fetchFromLeader(request: FetchRequest): FetchResponse = {
    // 发送网络请求
    val clientResponse = networkClient.sendAndReceive(
      request = request.toSend(
        destination = sourceBroker,
        responseDeadline = time.milliseconds() + request.timeoutMs
      ),
      ...
    )

    // 解析响应
    clientResponse.responseBody.asInstanceOf[FetchResponse]
  }
}
```scala

### 2.2 线程生命周期

```mermaid
stateDiagram-v2
    [*] --> Created: 线程创建
    Created --> Starting: 启动线程

    Starting --> Idle: 初始化完成
    Idle --> Fetching: 有分区需要拉取

    Fetching --> Processing: 收到响应
    Processing --> Idle: 处理完成
    Processing --> Fetching: 继续拉取

    Idle --> ShuttingDown: 停止请求
    Fetching --> ShuttingDown: 停止请求

    ShuttingDown --> [*]: 线程结束

    note right of Fetching
        持续拉取循环
        doWork()
    end note
```bash

### 2.3 分区管理

```scala
/**
 * 分区管理 - 添加和移除分区
 */

trait AbstractFetcherThread {

  // 当前拉取的分区
  protected val partitionStates = new PartitionStates[PartitionFetchState]()

  /**
   * 添加分区
   */
  def addPartitions(partitions: Set[TopicPartition]): Unit = {
    partitions.foreach { tp =>
      // 获取分区信息
      val partition = replicaMgr.getPartition(tp)
      val offset = partition.map(_.localLogOrException.logEndOffset).getOrElse(0L)

      // 添加到状态机
      partitionStates.put(
        topicPartition = tp,
        state = new PartitionFetchState(
          offset = offset,
          currentLeaderEpoch = ...,
          // 初始状态
          state = Fetching
        )
      )
    }
  }

  /**
   * 移除分区
   */
  def removePartitions(partitions: Set[TopicPartition]): Unit = {
    partitions.foreach { tp =>
      partitionStates.remove(tp)
    }
  }

  /**
   * 遍历需要拉取的分区
   */
  def partitionFetchStates: Iterable[(TopicPartition, PartitionFetchState)] = {
    partitionStates.stateMap.values.filter { state =>
      // 只返回正在拉取的分区
      state.state == Fetching
    }.map { state =>
      (state.topicPartition, state.fetchState)
    }
  }
}
```scala

---

## 3. 拉取请求构建

### 3.1 FetchRequest 结构

```scala
/**
 * FetchRequest - 拉取请求
 *
 * 协议版本演进:
 * - V0: 最初版本
 * - V1: 添加 sticky partitioning
 * - V3: 添加 Leader Epoch (KIP-101)
 * - V7: 添加 Rack ID
 * - V12: 添加 incremental fetch sessions
 */

class FetchRequest(
  // ========== 请求头 ==========
  val replicaId: Int,              // Follower 的 Broker ID
  val maxWaitMs: Int,              // 最大等待时间
  val minBytes: Int,               // 最小字节数
  val maxBytes: Int,               // 最大字节数
  val isolationLevel: IsolationLevel, // 隔离级别

  // ========== 分区信息 ==========
  val fetchData: Map[TopicPartition, FetchRequest.PartitionData],

  // ========== 其他 ==========
  val rackId: String,              // 机架 ID
  val fetchSessionId: Int,         // 增量拉取会话 ID
  val fetchSessionEpoch: Int       // 会话版本
) {

  def toSend(destination: BrokerEndPoint): RequestSend = {
    // 构建 NetworkSend 对象
    val header = new RequestHeader(
      apiKey = ApiKeys.FETCH,
      apiVersion = version,
      clientId = clientId,
      ...
    )

    val body = toStruct(version)
    new RequestSend(destination, header, body)
  }
}
```bash

### 3.2 请求构建流程

```scala
/**
 * 构建 FetchRequest
 */
override def buildFetchRequest(): FetchRequest = {

  // ========== 步骤1: 收集分区信息 ==========
  val partitionMap = new mutable.HashMap[TopicPartition, FetchRequest.PartitionData]()

  partitionFetchStates.foreach { case (tp, fetchState) =>
    val offset = fetchState.fetchOffset
    val leaderEpoch = fetchState.currentLeaderEpoch

    // 构建分区拉取数据
    partitionMap.put(tp, new FetchRequest.PartitionData(
      currentLeaderEpoch = leaderEpoch,
      fetchOffset = offset,
      logStartOffset = -1L,    // Follower 不需要
      maxBytes = config.replicaFetchMaxBytes,
      ...
    ))
  }

  // ========== 步骤2: 确定拉取参数 ==========
  val maxWait = config.replicaFetchWaitMaxMs
  val minBytes = config.replicaFetchMinBytes
  val maxBytes = config.replicaFetchMaxBytes

  // ========== 步骤3: 构建 FetchRequest ==========
  val request = new FetchRequest(
    replicaId = brokerConfig.brokerId,
    maxWaitMs = maxWait,
    minBytes = minBytes,
    maxBytes = maxBytes,
    fetchData = partitionMap.toMap,
    isolationLevel = IsolationLevel.READ_UNCOMMITTED,
    rackId = brokerConfig.rackId.orNull,
    ...
  )

  request
}
```text

### 3.3 增量拉取 (Incremental Fetch)
```scala
/**
 * 增量拉取 - KIP-227
 *
 * 优化: 只拉取有新数据的分区
 * 减少网络开销和 CPU 消耗
 */

class IncrementalFetcher {
  // ========== 拉取会话 ==========
  private var fetchSessionId = 0
  private val cachedPartitions = new ConcurrentHashMap[TopicPartition, PartitionData]()

  /**
   * 增量拉取请求
   */
  def buildIncrementalFetchRequest(): FetchRequest = {
    // ========== 步骤1: 确定哪些分区需要拉取 ==========
    val partitionsWithNewData = partitionStates.stateMap.values.filter { state =>
      // 检查是否有新数据
      hasNewData(state.topicPartition)
    }

    // ========== 步骤2: 构建请求 ==========
    val requestData = partitionsWithNewData.map { state =>
      state.topicPartition -> new PartitionData(
        fetchOffset = state.fetchOffset,
        maxBytes = config.replicaFetchMaxBytes,
        ...
      )
    }.toMap

    // ========== 步骤3: 使用增量会话 ==========
    new FetchRequest(
      replicaId = brokerConfig.brokerId,
      fetchSessionId = fetchSessionId,
      fetchData = requestData,
      ...
    )
  }

  /**
   * 处理增量响应
   */
  def processIncrementalResponse(response: FetchResponse): Unit = {
    // ========== 步骤1: 更新会话 ==========
    if (response.error() == Errors.NONE) {
      fetchSessionId = response.sessionId()
    }

    // ========== 步骤2: 只处理有数据的分区 ==========
    response.responses().forEach { response =>
      if (response.highWatermark() > 0) {
        // 有新数据, 处理
        processPartitionData(response)
      }
    }
  }
}
```scala

---

## 4. 响应处理流程

### 4.1 FetchResponse 结构

```scala
/**
 * FetchResponse - 拉取响应
 */

class FetchResponse(
  val errorCode: Errors,
  val sessionId: Int,
  val responses: Map[TopicPartition, FetchResponse.PartitionData]
) {

  def error(): Errors = errorCode
  def sessionId(): Int = sessionId

  def responses(): java.util.Map[TopicPartition, PartitionData] = {
    responses.asJava
  }
}

/**
 * 分区数据
 */
class PartitionData(
  val errorCode: Errors,
  val highWatermark: Long,           // HW
  val lastStableOffset: Long,        // 最后稳定 Offset (事务)
  val logStartOffset: Long,          // 日志起始 Offset
  val records: Records               // 消息记录
) {
  def error(): Errors = errorCode
  def highWatermark(): Long = highWatermark
  def records(): Records = records
}
```scala

### 4.2 响应处理流程

```scala
/**
 * 处理分区响应
 */
private def processPartitionResponse(fetchResponse: FetchResponse): Unit = {
  fetchResponse.responses().forEach { partitionData =>
    val tp = partitionData.topic
    val partitionId = partitionData.partition
    val topicPartition = new TopicPartition(tp, partitionId)

    try {
      // ========== 步骤1: 检查错误 ==========
      if (partitionData.error() != Errors.NONE) {
        handleError(topicPartition, partitionData.error())
        return
      }

      // ========== 步骤2: 提取记录 ==========
      val records = partitionData.records()
      val highWatermark = partitionData.highWatermark()

      if (records != null && records.sizeInBytes() > 0) {
        // ========== 步骤3: 写入本地日志 ==========
        val partition = replicaMgr.getPartition(topicPartition)

        partition match {
          case Some(p) =>
            val log = p.localLogOrException

            // 写入日志
            val logAppendInfo = log.appendAsFollower(
              records = records,
              isFromFollower = true
            )

            // ========== 步骤4: 更新 LEO ==========
            val newLEO = logAppendInfo.lastOffset + 1
            replicaMgr.updateFollowerLEO(
              partition = p,
              replicaId = sourceBroker.id,
              leo = newLEO
            )

            // ========== 步骤5: 更新拉取状态 ==========
            partitionStates.update(
              topicPartition = topicPartition,
              state = new PartitionFetchState(
                offset = newLEO,
                currentLeaderEpoch = ...,
                state = Fetching
              )
            )

            // ========== 步骤6: 更新指标 ==========
            fetcherLagStats.getAndMaybePut(topicPartition).lag = highWatermark - newLEO

          case None =>
            warn(s"Partition $topicPartition not found")
        }
      }

    } catch {
      case e: Exception =>
        error(s"Error processing fetch response for partition $topicPartition", e)
        handleFetchError(topicPartition, e)
    }
  }
}
```bash

### 4.3 日志追加

```scala
/**
 * 日志追加 - Follower 端
 */

class UnifiedLog {
  /**
   * 作为 Follower 追加记录
   */
  def appendAsFollower(
    records: Records,
    isFromFollower: Boolean = true
  ): LogAppendInfo = {

    // ========== 步骤1: 验证记录 ==========
    if (records.sizeInBytes() > 0) {
      validateRecords(records)
    }

    // ========== 步骤2: 追加到日志 ==========
    val appendInfo = append(
      records = records,
      isFromClient = false,
      interBrokerProtocolVersion = ...
    )

    // ========== 步骤3: 不更新 HW ==========
    // Follower 的 HW 由 Leader 决定
    // 不需要更新 HW

    appendInfo
  }
}
```scala

---

## 5. 拉取性能优化

### 5.1 批量拉取优化

```scala
/**
 * 批量拉取优化
 */

object FetchOptimization {

  // ========== 1. 增加拉取字节大小 ==========
  // 单次拉取更多数据, 减少往返次数
  val replicaFetchMaxBytes = 10 * 1024 * 1024  // 10MB

  // ========== 2. 调整最小字节 ==========
  // 等待积累足够数据再响应
  val replicaFetchMinBytes = 1 * 1024  // 1KB

  // ========== 3. 调整最大等待时间 ==========
  // 平衡延迟和吞吐量
  val replicaFetchWaitMaxMs = 500  // 500ms

  // ========== 4. 增加拉取线程数 ==========
  // 并行拉取多个分区
  val numReplicaFetchers = 2  // 2 个拉取线程

  // ========== 5. 启用增量拉取 ==========
  // 只拉取有新数据的分区
  val incrementalFetchSessionEnabled = true
}
```bash

### 5.2 网络优化

```scala
/**
 * 网络层优化
 */

object NetworkOptimization {

  // ========== 1. 启用数据压缩 ==========
  // 减少网络传输量
  val compressionType = "lz4"  // 或 "gzip", "snappy", "zstd"

  // ========== 2. 调整缓冲区大小 ==========
  val socketReceiveBufferBytes = 64 * 1024  // 64KB
  val socketSendBufferBytes = 64 * 1024

  // ========== 3. 启用 TCP_NODELAY ==========
  // 禁用 Nagle 算法, 减少延迟
  val socketTcpNoDelay = true

  // ========== 4. 调整连接超时 ==========
  val connectionsSetupTimeoutMs = 10000  // 10s
  val connectionsSetupTimeoutMaxMs = 30000  // 30s

  // ========== 5. 启用机架感知 ==========
  // 优先从同机架拉取
  val brokerRack = "rack-1"
}
```scala

### 5.3 磁盘 I/O 优化

```scala
/**
 * 磁盘 I/O 优化
 */

object DiskOptimization {

  // ========== 1. 调整日志段大小 ==========
  // 减少文件打开次数
  val logSegmentBytes = 1 * 1024 * 1024 * 1024  // 1GB

  // ========== 2. 启用日志 Flush ==========
  // 定期刷盘, 平衡性能和可靠性
  val logFlushIntervalMessages = Long.MaxValue  // 不基于消息数
  val logFlushIntervalMs = Long.MaxValue        // 不基于时间

  // ========== 3. 调整页面缓存 ==========
  // 让操作系统管理缓存
  val logFlushSchedulerIntervalMs = Long.MaxValue

  // ========== 4. 使用 NIO ==========
  // 减少线程切换
  val numIoThreads = 8  // I/O 线程数
}
```scala

---

## 6. 故障处理与重试

### 6.1 常见错误处理

```scala
/**
 * 处理拉取错误
 */

object FetchErrorHandler {

  /**
   * 处理分区错误
   */
  def handlePartitionError(
    topicPartition: TopicPartition,
    error: Errors
  ): Unit = {

    error match {
      // ========== 错误 1: 分区不存在 ==========
      case Errors.UNKNOWN_TOPIC_OR_PARTITION =>
        warn(s"Unknown topic or partition: $topicPartition")
        // 等待元数据更新

      // ========== 错误 2: 不是 Leader ==========
      case Errors.NOT_LEADER_OR_FOLLOWER =>
        warn(s"Broker is not leader or follower for $topicPartition")
        // 更新元数据, 重新连接 Leader

      // ========== 错误 3: Leader Epoch 过期 ==========
      case Errors.FENCED_LEADER_EPOCH =>
        warn(s"Fenced leader epoch for $topicPartition")
        // 发送 OffsetForLeaderEpochRequest

      // ========== 错误 4: 分区正在迁移 ==========
      case Errors.PARTITION_MOVING =>
        info(s"Partition $topicPartition is moving")
        // 等待迁移完成

      // ========== 错误 5: 网络错误 ==========
      case Errors.NETWORK_EXCEPTION =>
        warn(s"Network error for $topicPartition")
        // 重试

      case _ =>
        error(s"Unexpected error for $topicPartition: $error")
    }
  }
}
```text

### 6.2 重试机制
```scala
/**
 * 重试策略
 */

class RetryPolicy(
  val maxRetries: Int = 3,
  val retryBackoffMs: Long = 1000
) {

  private var retryCount = 0
  private var lastRetryTime = 0L

  /**
   * 判断是否应该重试
   */
  def shouldRetry(error: Errors): Boolean = {
    // ========== 可重试的错误 ==========
    val retriableErrors = Set(
      Errors.NETWORK_EXCEPTION,
      Errors.REQUEST_TIMED_OUT,
      Errors.NOT_LEADER_OR_FOLLOWER
    )

    if (retriableErrors.contains(error) && retryCount < maxRetries) {
      retryCount += 1
      lastRetryTime = System.currentTimeMillis()
      true
    } else {
      false
    }
  }

  /**
   * 获取重试延迟
   */
  def retryDelayMs(): Long = {
    val currentTime = System.currentTimeMillis()
    val elapsed = currentTime - lastRetryTime

    if (elapsed < retryBackoffMs) {
      retryBackoffMs - elapsed
    } else {
      0L
    }
  }
}
```bash

### 6.3 Leader 切换处理

```scala
/**
 * Leader 切换处理
 */

class LeaderChangeHandler(
  replicaMgr: ReplicaManager,
  metadataCache: MetadataCache
) {

  /**
   * 检测 Leader 是否变化
   */
  def detectLeaderChange(topicPartition: TopicPartition): Boolean = {
    val currentLeader = metadataCache.getAliveLeader(topicPartition)

    // 检查 Leader 是否变化
    currentLeader.broker != sourceBroker.id
  }

  /**
   * 处理 Leader 变化
   */
  def handleLeaderChange(topicPartition: TopicPartition): Unit = {
    info(s"Leader changed for partition $topicPartition")

    // ========== 步骤1: 停止从旧 Leader 拉取 ==========
    removeFetcherForPartitions(Set(topicPartition))

    // ========== 步骤2: 获取新 Leader 信息 ==========
    val newLeader = metadataCache.getAliveLeader(topicPartition)

    // ========== 步骤3: 创建到新 Leader 的拉取线程 ==========
    addFetcherForPartitions(Set(topicPartition))

    // ========== 步骤4: 可能需要截断日志 ==========
    truncateIfNecessary(topicPartition)
  }

  /**
   * 截断日志 (如果需要)
   */
  private def truncateIfNecessary(topicPartition: TopicPartition): Unit = {
    // 发送 OffsetForLeaderEpochRequest
    // 获取新 Leader 的 Epoch 和 Offset
    // 截断到该 Epoch 的结束 Offset
  }
}
```text

---

## 7. 总结

### 7.1 拉取机制核心要点

| 要点 | 说明 |
|-----|------|
| **拉取线程** | 每个 Leader 对应一个线程 |
| **拉取频率** | 持续拉取, 由 maxWaitMs 控制 |
| **批量拉取** | 一次拉取多个分区 |
| **增量拉取** | 只拉取有新数据的分区 |
| **错误处理** | 自动重试, Leader 切换 |

### 7.2 性能调优建议
```
1. 增加拉取线程数
   └── num.replica.fetchers = 2

2. 增加拉取字节
   └── replica.fetch.max.bytes = 10485760

3. 调整等待时间
   └── replica.fetch.wait.max.ms = 500

4. 启用压缩
   └── compression.type = lz4

5. 启用增量拉取
   └── (默认启用)
```

---

**下一步**: [04. 副本状态机](./04-replica-state.md)
