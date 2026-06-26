# Kafka 源码教程常见问题 FAQ

> **本文档导读**
>
> 本 FAQ 收集了使用本教程中常见的问题和解决方案，帮助开发者快速解决问题。

---

## 目录
- [一般问题](#一般问题)
- [生产者相关](#生产者相关)
- [消费者相关](#消费者相关)
- [部署和运维](#部署和运维)
- [性能调优](#性能调优)
- [常见错误](#常见错误)

---

## 一般问题

### Q1: 这个教程适用于哪个 Kafka 版本？
**A:** 本教程主要针对 Kafka 3.x 版本，特别关注 KRaft 架构的新特性。对于 Kafka 2.x 版本，部分内容也具有参考价值，但某些功能（如 KRaft）不可用。

### Q2: 学习这个教程需要什么前置知识？
**A:** 建议具备以下知识：
- 基本的 Java/Scala 编程基础
- 消息队列基本概念
- 分布式系统基础原理
- Kafka 基本使用经验

### Q3: 如何快速上手 Kafka 开发？
**A:** 推荐学习路径：
1. 先阅读 [架构概览](./00-intro/00-architecture-overview.md]
2. 然后学习 [Producer 实战指南](./09-producer/09-producer-practical-guide.md)
3. 接着学习 [Consumer 实战指南](./10-consumer/09-consumer-practical-guide.md)
4. 根据需要深入其他模块

### Q4: ZooKeeper 模式和 KRaft 模式的主要区别是什么？
**A:** 主要区别：

| 特性 | ZooKeeper 模式 | KRaft 模式 |
|------|---------------|------------|
| 元数据管理 | 外部 ZooKeeper | 内部 __cluster_metadata Topic |
| 控制器选举 | ZooKeeper 协调 | Raft 协议 |
| 可扩展性 | 受 ZooKeeper 限制 | 理论无限扩展 |
| 运维复杂度 | 需要维护两套系统 | 只需维护 Kafka |
| 元数据延迟 | Watch 机制 | 直接查询 |

详见 [KRaft 架构概览](./05-controller/01-krft-overview.md]

---

## 生产者相关

### Q5: 如何保证消息不丢失？
**A:** 要保证消息不丢失，需要以下配置：

```java
props.put(ProducerConfig.ACKS_CONFIG, "all"); // 或 "-1"
props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");
props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, "5");
```

同时 Broker 端配置：
```properties
min.insync.replicas=2
unclean.leader.election.enable=false
```

### Q6: 如何提高生产者吞吐量？
**A:** 提高吞吐量的关键配置：
- 增加 `batch.size`（默认 16384 → 推荐 65536）
- 增加 `linger.ms`（默认 0 → 推荐 10-20）
- 增加 `buffer.memory`（默认 33554432 → 推荐 134217728）
- 启用压缩：`compression.type=lz4`
- 增加 `max.request.size`
- 使用异步发送

详见 [Producer 实战指南](./09-producer/09-producer-practical-guide.md#3-性能调优实战)

### Q7: 幂等生产者和事务生产者的区别？
**A:**
- **幂等生产者**：保证单分区内不重复，使用 `enable.idempotence=true`
- **事务生产者**：跨分区原子性，使用 `transactional.id`

### Q8: 如何处理发送失败？
**A:** 失败处理策略：
1. 启用重试可重试异常自动重试
2. 使用回调函数处理结果
3. 记录失败消息，稍后重试
4. 考虑死信队列处理无法恢复的消息

### Q9: 什么情况下会发生消息重复？
**A:** 消息重复的常见原因：
- 生产者重试但 Broker 已成功
- 消费者提交 Offset 失败但未成功消费
- 网络超时但实际成功

---

## 消费者相关

### Q10: 如何避免消息不丢失？
**A:**
1. 禁用自动提交：`enable.auto.commit=false`
2. 消费完成后再手动提交 Offset
3. 使用 `isolation.level=read_committed`（如果使用事务）

### Q11: 消费者组中消费者数量和分区数的关系？
**A:**
- 消费者数 <= 分区数：每个消费者消费至少一个分区
- 消费者数 > 分区数：多余的消费者会空闲
- 理想情况：消费者数 = 分区数（最大化并行

### Q12: 什么情况下会触发 Rebalance？
**A:** 触发 Rebalance 的情况：
- 消费者组成员变化（加入/离开/崩溃
- 订阅的 Topic 变化
- Topic 分区数变化

### Q13: 如何减少 Rebalance 影响？
**A:**
- 合理设置 `session.timeout.ms` 和 `max.poll.interval.ms`
- 避免长时间消费逻辑
- 使用静态成员资格（`group.instance.id`）
- 增加 `heartbeat.interval.ms` 更频繁地发送心跳

### Q14: 消费滞后（Lag）持续增加怎么办？
**A:** 排查步骤：
1. 检查消费者是否正常运行
2. 检查消费者数量是否足够
3. 检查消费逻辑是否过慢
4. 增加消费者数量（不超过分区数）
5. 优化消费逻辑
6. 检查网络和 Broker 性能

---

## 部署和运维

### Q15: 生产环境推荐的配置建议？
**A:**
- 集群规模：至少 3 个 Controller 节点（奇数
- Broker 配置：根据负载和性能需求调整 JVM 堆大小
- 日志保留：根据业务需求配置
- 监控：配置 JMX 监控，配置告警
- 备份：定期备份元数据
- 安全：配置认证和授权

详见 [部署指南](./05-controller/08-deployment-guide.md)

### Q16: 如何从 ZooKeeper 模式迁移到 KRaft 模式？
**A:** Kafka 3.3+ 至 3.x 支持在线双向迁移（Kafka 4.0 已移除 ZooKeeper 模式及迁移工具，需在 3.x 阶段完成迁移）。迁移步骤：
1. 准备 KRaft Controller 集群
2. 配置元数据复制
3. 执行迁移
4. 验证迁移成功
5. 清理旧配置
详见 [迁移指南](./05-controller/18-migration-guide.md)

### Q17: 常用的 Kafka 监控指标有哪些？
**A:** 关键监控指标：

**Broker 指标：**
- UnderReplicatedPartitions
- IsrShrinksPerSec
- RequestHandlerAvgIdlePercent
- MessagesInPerSec
- BytesInPerSec/BytesOutPerSec

**Producer 指标：**
- record-send-rate
- record-error-rate
- request-latency-avg

**Consumer 指标：**
- records-consumed-rate
- records-lag
- fetch-latency-avg

详见 [监控文档](./05-controller/10-monitoring.md)

### Q18: 如何备份 Kafka 数据？
**A:** 备份策略：
1. 使用 MirrorMaker 2.0 跨集群复制
2. 定期备份元数据
3. 使用云存储备份日志文件
4. 使用第三方工具备份
详见 [备份恢复](./05-controller/17-backup-recovery.md)

---

## 性能调优

### Q19: 如何进行性能基准测试？
**A:** 使用 Kafka 自带工具：
```bash
# 生产者性能测试
bin/kafka-producer-perf-test.sh --topic test --num-records 1000000 --record-size 1024 --throughput -1 --producer-props bootstrap.servers=localhost:9092

# 消费者性能测试
bin/kafka-consumer-perf-test.sh --topic test --bootstrap-server localhost:9092 --messages 1000000
```

### Q20: JVM 参数如何调优？
**A:** 推荐 JVM 配置：
```bash
# 堆大小
-Xms4g -Xmx4g

# GC 配置
-XX:+UseG1GC
-XX:MaxGCPauseMillis=20
-XX:InitiatingHeapOccupancyPercent=35

# 其他优化
-XX:+AlwaysPreTouch
-XX:+ExplicitGCInvokesConcurrent
-XX:InitiatingHeapOccupancyPercent=45
```

### Q21: 分区数多少合适？
**A:** 考虑因素：
- 预期吞吐量
- 消费者并行度
- Broker 处理能力
- 一般建议：每 Broker 100-1000 个分区

一般经验：分区数 = 目标吞吐量 / 单分区吞吐量

### Q22: 副本数配置多少合适？
**A:**
- 开发环境：1（生产环境
- 生产环境：3（最小 2，推荐 3）
- 关键业务：3 或更多
- 同时设置 `min.insync.replicas=2`

---

## 常见错误

### Q23: LeaderNotAvailableException
**错误信息：** `This server is not the leader for that topic-partition`

**原因：**
- Leader 正在选举或已变化
- 元数据过期

**解决：**
- 等待 Leader 选举完成
- 刷新元数据
- 增加重试次数

### Q24: TimeoutException
**错误信息：** `Request timed out`

**原因：**
- 网络问题
- Broker 负载过高
- 请求超时时间过短

**解决：**
- 增加 `request.timeout.ms`
- 检查网络连接
- 检查 Broker 负载
- 减少批量大小

### Q25: OffsetOutOfRangeException
**错误信息：** `Offsets out of range`

**原因：**
- 请求的 Offset 不存在
- 日志已被清理
- 消费者 Offset 太久未更新

**解决：**
- 设置 `auto.offset.reset` 为 `earliest` 或 `latest`
- 检查 Offset 管理策略

### Q26: NotEnoughReplicasException
**错误信息：** `Messages are rejected since there are fewer in-sync replicas than required`

**原因：**
- ISR 副本数不足
- 副本同步滞后

**解决：**
- 检查副本状态
- 临时降低 `min.insync.replicas`
- 解决副本同步问题

### Q27: RecordTooLargeException
**错误信息：** `The message is 1048588 bytes when serialized which is larger than the maximum request size you have configured with the max.request.size configuration`

**原因：**
- 消息大小超过限制

**解决：**
- 增加 `max.request.size`
- 增加 Broker 端 `message.max.bytes`
- 增加 Topic 级别 `max.message.bytes`
- 考虑拆分大消息

### Q28: CommitFailedException
**错误信息：** `Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member`

**原因：**
- 消费者处理时间过长
- `max.poll.interval.ms` 过小
- 消费者心跳超时

**解决：**
- 增加 `max.poll.interval.ms`
- 优化消费逻辑
- 减少 `max.poll.records`

---

## 更多资源

- [Kafka 官方文档](https://kafka.apache.org/documentation/)
- [Kafka 源码仓库](https://github.com/apache/kafka)
- [本教程完整索引](./index.md)
- [常见问题继续收集，欢迎提交 Issue！
