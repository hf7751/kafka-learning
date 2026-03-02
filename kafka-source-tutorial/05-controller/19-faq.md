# 19. 常见问题解答

> **本文档导读**
>
> 本文档收集了 KRaft 相关的常见问题和解答。
>
> **预计阅读时间**: 20 分钟
>
> **相关文档**:
> - [11-troubleshooting.md](./11-troubleshooting.md) - 故障排查指南
> - [20-comparison.md](./20-comparison.md) - KRaft vs ZooKeeper 对比

---

## 16. 常见问题 FAQ

### Q1: KRaft 模式下如何查看 Controller Leader?

```bash
# 方法 1: 使用 kafka-metadata-quorum.sh
bin/kafka-metadata-quorum.sh describe --status

# 方法 2: 使用 JMX
jconsole
# 查看 kafka.controller:type=KafkaController,name=ActiveControllerCount

# 方法 3: 查看日志
grep "Becoming leader" /tmp/kraft-combined-logs/server.log
```

### Q2: 如何验证 KRaft 集群健康状态?

```bash
# 1. 检查 Controller Quorum
bin/kafka-metadata-quorum.sh describe --status

# 2. 检查所有 Broker 注册
bin/kafka-metadata-shell.sh --snapshot <snapshot-file>
>> cd /brokers/ids
>> ls

# 3. 检查分区 Leader 分布
bin/kafka-topics.sh --describe --bootstrap-server localhost:9092

# 4. 检查元数据日志
ls -la /tmp/kraft-combined-logs/metadata/
```

### Q3: KRaft 模式下 Controller 能否动态调整?

```scala
/**
 * 答案: 可以，但有限制
 *
 * 1. 增加 Controller
 *    - 停止集群
 *    - 更新所有节点的 controller.quorum.voters
 *    - 启动新 Controller
 *    - 重启集群
 *
 * 2. 减少 Controller
 *    - 注意: 需要保持多数派
 *    - 从 voters 列表移除节点
 *    - 重启集群
 *
 * 3. 最佳实践:
 *    - 部署时就规划好 Controller 数量
 *    - 使用奇数个 Controller (3, 5, 7)
 *    - 避免频繁调整
 */
```

### Q4: KRaft 与 ZooKeeper 模式如何迁移?

```bash
# ==================== ZK 迁移到 KRaft ====================

# 1. 导出 ZooKeeper 元数据
bin/kafka-metadata-tools.sh --export \
  --zookeeper.connect localhost:2181 \
  --output-file zk-metadata.json

# 2. 生成 KRaft 集群 ID
KAFKA_CLUSTER_ID=$(bin/kafka-storage.sh random-uuid)

# 3. 格式化 KRaft 存储并导入元数据
bin/kafka-storage.sh format \
  -t $KAFKA_CLUSTER_ID \
  -c config/kraft/server.properties \
  --ignore-formatted

# 4. 验证迁移
bin/kafka-topics.sh --list --bootstrap-server localhost:9092

# 注意: Kafka 3.x 提供了迁移工具
# bin/kafka-migration-mode.sh --zookeeper.connect localhost:2181
```

### Q5: 如何监控 Raft 协议状态?

```bash
# 1. 查看 Raft 指标
curl http://localhost:9092/metrics | grep raft

# 2. 关键指标
# - raft_leader_epoch: Leader 任期
# - raft_commit_latency: 提交延迟
# - raft_append_latency: 追加延迟
# - raft_snapshot_count: 快照数量

# 3. 实时监控
watch -n 1 'curl -s http://localhost:9092/metrics | grep raft_commit_latency'
```

---

**本章总结**

本章深入分析了 Kafka KRaft 架构的核心——Controller。通过源码分析，我们了解了：

1. **KRaft 架构如何替代 ZooKeeper**：通过 Raft 协议实现元数据一致性，消除了对外部协调服务的依赖
2. **QuorumController 单线程事件模型**：简化并发控制，保证操作顺序性
3. **元数据发布机制**：通过 Publisher 模式，将元数据变更通知到各个组件
4. **Raft 协议集成**：自动故障转移，强一致性保证

**实战要点**：
- 掌握 KRaft 集群的部署和配置方法
- 了解 Controller 关键监控指标和告警配置
- 熟悉常见问题的排查和解决方法
- 理解性能调优的最佳实践

**核心设计亮点**：
- 单线程事件模型避免锁竞争
- 元数据快照机制实现快速恢复
- Publisher 观察者模式解耦元数据处理
- Raft 协议保证高可用和一致性

**下一章预告**：我们将分析 GroupCoordinator，了解 Consumer Group 的协调机制和 Rebalance 过程。
