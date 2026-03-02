# 04. Raft 协议实现

> **本文档导读**
>
> 本文档介绍 Raft 协议在 Kafka 中的具体实现，包括 Leader 选举、日志复制等机制。
>
> **预计阅读时间**: 40 分钟
>
> **相关文档**:
> - [01-krft-overview.md](./01-krft-overview.md) - KRaft 架构概述
> - [03-quorum-controller.md](./03-quorum-controller.md) - QuorumController 核心实现

---

## 4. Raft 协议实现

### 4.1 Raft 基础概念

```scala
/**
 * Raft 协议核心概念:
 *
 * 1. 角色类型
 *    - Leader: 处理所有写请求
 *    - Follower: 复制 Leader 的日志
 *    - Candidate: 选举中的临时状态
 *
 * 2. 术语
 *    - Term (任期): 逻辑时钟，每次选举后递增
 *    - Log Entry: 日志条目，包含元数据记录
 *    - Commit Index: 已提交的最大索引
 *    - High Watermark: 多数节点已复制的索引
 *
 * 3. 一致性保证
 *    - Leader 完整性: 如果一条记录在某个 Term 提交，
 *                    它将在所有后续 Term 的 Leader 中存在
 *    - 日志匹配性: 两个日志如果索引相同，则记录相同
 *    - 领导者附加性: Leader 不会覆盖或删除已提交的记录
 */
```

### 4.2 Raft 状态转换

```mermaid
stateDiagram-v2
    [*] --> Follower: 集群启动
    Follower --> Follower: 收到心跳 (Term 相等)
    Follower --> Follower: 收到 AppendEntries (Term 相等)
    Follower --> Candidate: 选举超时
    Follower --> Follower: 收到更高 Term 的请求

    Candidate --> Leader: 获得多数票
    Candidate --> Candidate: 收到票数不足，重新开始
    Candidate --> Follower: 发现有更高 Term 的 Leader
    Candidate --> Follower: 选举超时，未获得多数票

    Leader --> Follower: 收到更高 Term 的请求
    Leader --> Follower: 网络分区导致失去领导权

    note right of Leader
        Leader 可以:
        - 接受写请求
        - 追加日志记录
        - 复制到 Follower
        - 提交已确认的记录
    end note

    note right of Follower
        Follower 可以:
        - 接受 Leader 的日志复制
        - 响应心跳
        - 转发写请求给 Leader
    end note
```

### 4.3 Leader 选举流程

```mermaid
sequenceDiagram
    participant F1 as Follower 1
    participant F2 as Follower 2
    participant F3 as Follower 3
    participant C as Candidate

    Note over F1,F3: Term N, 正常运行

    F1--xF1: Leader 故障
    F2--xF2: Leader 故障
    F3--xC3: Leader 故障

    Note over F1,F3: 选举超时等待

    F1->>F1: 超时，转为 Candidate<br/>Term = N+1
    F1->>F2: RequestVote (Term N+1)
    F1->>F3: RequestVote (Term N+1)

    F2->>F2: 投票给 F1
    F3->>F3: 投票给 F1

    F2--xF1: 投票给 F1
    F3--xF1: 投票给 F1

    F1->>F1: 获得多数票<br/>成为 Leader

    F1->>F2: AppendEntries (心跳, Term N+1)
    F1->>F3: AppendEntries (心跳, Term N+1)

    Note over F1,F3: Term N+1, 新 Leader 就绪
```

### 4.4 日志复制流程

```mermaid
sequenceDiagram
    participant C as Client
    participant L as Leader
    participant F1 as Follower 1
    participant F2 as Follower 2
    participant F3 as Follower 3

    C->>L: 写入元数据记录

    L->>L: 追加到本地日志<br/>(未提交)

    Note over L: 并行复制到所有 Follower

    par 并行复制
        L->>F1: AppendEntries (记录)
        L->>F2: AppendEntries (记录)
        L->>F3: AppendEntries (记录)
    end

    F1--xL: ACK (成功)
    F2--xL: ACK (成功)
    F3--xL: ACK (超时/失败)

    Note over L: 收到多数确认 (F1, F2)

    L->>L: 提交记录<br/>更新 Commit Index

    L--xC: 返回成功

    Note over L,F3: 下次心跳时<br/>Leader 会重试 F3
```

### 4.5 KafkaRaftManager 实现

```scala
// kafka/raft/KafkaRaftManager.scala

class KafkaRaftManager[MessageType](
    config: KafkaConfig,
    clientConfig: RaftConfig,
    time: Time,
    threadNamePrefix: Option[String],
    val metrics: Metrics,
    val scheduler: Scheduler,
    val topicPartition: TopicPartition,
    val apiVersionManager: ApiVersionManager,
    val listenerName: ListenerName,
    val storageDir: File
) extends Logging {

  /**
   * Raft 客户端: 与 Raft 集群交互
   */
  @volatile var client: RaftClient[MessageType] = _

  /**
   * Raft 服务器: 处理 Raft 协议消息
   */
  @volatile var server: KafkaRaftServer[MessageType] = _

  def startup(): Unit = {
    // ========== 1. 创建 Raft IO 层 ==========
    /**
     * RaftIO 负责:
     * - 读写日志文件
     * - 创建快照
     * - 加载快照
     */
    val raftIo = new RaftIo(
      metadataPartition,
      config,
      time,
      scheduler,
      apiVersionManager
    )

    // ========== 2. 创建 RaftClient ==========
    /**
     * RaftClient 提供给上层使用
     * 用于:
     * - 追加记录
     * - 读取记录
     * - 查询 Leader 信息
     */
    client = RaftClient.newBuilder()
      .setNodeId(config.nodeId)
      .setRaftConfig(clientConfig)
      .setTime(time)
      .setLogContext(logContext)
      .build()

    // ========== 3. 创建 RaftServer ==========
    /**
     * RaftServer 处理:
     * - Raft 协议消息
     * - 选举
     * - 日志复制
     * - 快照管理
     */
    server = KafkaRaftServer.newBuilder()
      .setNodeId(config.nodeId)
      .setRaftConfig(clientConfig)
      .setRaftClient(client)
      .setTime(time)
      .build()

    server.start()
  }

  /**
   * 追加记录到元数据日志
   * 这是一个异步操作
   */
  def append(
    records: JavaList[ApiMessageAndVersion],
    timeoutMs: Long,
    waitForAll: Boolean
  ): CompletableFuture[Long] = {
    client.append(records, timeoutMs, waitForAll)
  }

  /**
   * 读取元数据日志
   */
  def read(
    startOffset: Long,
    maxBytes: Int
  ): JavaOptional[BatchReader[MessageType]] = {
    client.read(startOffset, maxBytes)
  }

  /**
   * 获取当前 Leader 信息
   */
  def leaderAndEpoch(): LeaderAndEpoch = {
    client.leaderAndEpoch()
  }
}
```

---
