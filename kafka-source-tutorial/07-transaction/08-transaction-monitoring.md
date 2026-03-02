# 08. 事务监控

## 本章导读

监控 Kafka 事务对于保证系统稳定性和性能至关重要。本章介绍事务相关的 JMX 指标、监控工具、告警配置以及监控最佳实践。

---

## 1. JMX 监控指标

### 1.1 生产者指标

```scala
/**
 * 事务生产者 JMX 指标
 */

object ProducerTransactionMetrics {
    /**
     * 事务开始次数
     * - Type: Counter
     * - 单位: 次
     */
    val TX_BEGIN = "tx-begin"

    /**
     * 事务提交次数
     * - Type: Counter
     * - 单位: 次
     */
    val TX_COMMIT = "tx-commit"

    /**
     * 事务回滚次数
     * - Type: Counter
     * - 单位: 次
     */
    val TX_ABORT = "tx-abort"

    /**
     * 事务发送成功率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val TX_SUCCESS_RATE = "tx-success-rate"

    /**
     * 事务失败率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val TX_FAILURE_RATE = "tx-failure-rate"

    /**
     * 事务提交耗时
     * - Type: Histogram
     * - 单位: 毫秒
     */
    val TX_COMMIT_LATENCY = "tx-commit-latency"

    /**
     * 事务回滚耗时
     * - Type: Histogram
     * - 单位: 毫秒
     */
    val TX_ABORT_LATENCY = "tx-abort-latency"
}
```

### 1.2 TransactionCoordinator 指标

```scala
/**
 * TransactionCoordinator JMX 指标
 */

object CoordinatorMetrics {
    /**
     * 活跃事务数量
     * - Type: Gauge
     * - 单位: 个
     */
    val ACTIVE_TX_COUNT = "ActiveTransactionCount"

    /**
     * 事务提交成功率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val TX_COMMIT_SUCCESS_RATE = "TransactionCommitSuccessRate"

    /**
     * 事务回滚成功率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val TX_ABORT_SUCCESS_RATE = "TransactionAbortSuccessRate"

    /**
     * Transaction Marker 发送成功率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val TX_MARKER_SEND_SUCCESS_RATE = "TransactionMarkerSendSuccessRate"

    /**
     * 事务超时次数
     * - Type: Counter
     * - 单位: 次
     */
    val TX_TIMEOUT_COUNT = "TransactionTimeoutCount"

    /**
     * 事务错误次数
     * - Type: Counter
     * - 单位: 次
     */
    val TX_ERROR_COUNT = "TransactionErrorCount"

    /**
     * Producer ID 分配次数
     * - Type: Counter
     * - 单位: 次
     */
    val PRODUCER_ID_ALLOCATION_RATE = "ProducerIdAllocationRate"

    /**
     * 事务日志写入延迟
     * - Type: Histogram
     * - 单位: 毫秒
     */
    val TX_LOG_APPEND_LATENCY = "TransactionLogAppendLatency"
}
```

### 1.3 __transaction_state Topic 指标

```scala
/**
 * __transaction_state Topic 监控指标
 */

object TransactionLogMetrics {
    /**
     * 日志大小
     * - Type: Gauge
     * - 单位: 字节
     */
    val LOG_SIZE = "LogSize"

    /**
     * 消息数量
     * - Type: Gauge
     * - 单位: 条
     */
    val NUM_MESSAGES = "NumMessages"

    /**
     * 日志写入速率
     * - Type: Gauge
     * - 单位: 条/秒
     */
    val LOG_APPEND_RATE = "LogAppendRate"

    /**
     * 日志压缩比率
     * - Type: Gauge
     * - 单位: 百分比
     */
    val COMPRESSION_RATIO = "CompressionRatio"

    /**
     * 清理延迟
     * - Type: Gauge
     * - 单位: 毫秒
     */
    val CLEANER_LOG_COMPRESSION_TIME_MS = "CleanerLogCompasionTimeMs"
}
```

---

## 2. 监控工具

### 2.1 JConsole

```bash
# 启动 Kafka Broker 时启用 JMX
export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false \
  -Dcom.sun.management.jmxremote.port=9999"

# 启动 Broker
bin/kafka-server-start.sh config/server.properties

# 使用 JConsole 连接
jconsole localhost:9999
```

### 2.2 Prometheus + Grafana

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'kafka'
    static_configs:
      - targets: ['localhost:9999']
```

```properties
# Kafka JMX Exporter 配置
---
# 事务相关指标
- pattern: 'kafka.coordinator.transaction.<type>(<name>)'
  name: kafka_coordinator_transaction_$1_$2
  labels:
    type: $1
  help: "Kafka TransactionCoordinator metrics"

- pattern: 'kafka.producer.<type>(<name>)'
  name: kafka_producer_$1_$2
  labels:
    type: $1
  help: "Kafka Producer transaction metrics"
```

### 2.3 Kafka 自带工具

```bash
# 查看 Producer 状态
bin/kafka-producer-perf-test.sh \
  --topic transactions \
  --num-records 10000 \
  --record-size 100 \
  --throughput 10000 \
  --producer-props \
    bootstrap.servers=localhost:9092 \
    transactional.id=test-producer \
    enable.idempotence=true

# 查看事务消息
bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic transactions \
  --isolation-level read_committed \
  --from-beginning
```

---

## 3. 关键性能指标 (KPI)

### 3.1 事务吞吐量

```scala
/**
 * 事务吞吐量指标
 */

object TransactionThroughput {
    /**
     * 定义
     * - 每秒完成的事务数量
     * - 单位: TPS (Transactions Per Second)
     */

    /**
     * 计算方式
     */
    def calculateTPS(commits: Long, duration: Long): Double = {
        commits.toDouble / duration * 1000.0
    }

    /**
     * 监控建议
     * - 正常: > 100 TPS
     * - 警告: < 50 TPS
     * - 严重: < 10 TPS
     */
}
```

### 3.2 事务延迟

```scala
/**
 * 事务延迟指标
 */

object TransactionLatency {
    /**
     * P50 延迟
     * - 50% 的事务延迟
     * - 正常: < 100ms
     */

    /**
     * P95 延迟
     * - 95% 的事务延迟
     * - 正常: < 500ms
     */

    /**
     * P99 延迟
     * - 99% 的事务延迟
     * - 正常: < 1000ms
     */

    /**
     * 最大延迟
     * - 最慢的事务延迟
     * - 正常: < 5000ms
     */
}
```

### 3.3 事务成功率

```scala
/**
 * 事务成功率指标
 */

object TransactionSuccessRate {
    /**
     * 计算方式
     */
    def calculateSuccessRate(commits: Long, aborts: Long): Double = {
        commits.toDouble / (commits + aborts) * 100.0
    }

    /**
     * 监控建议
     * - 正常: > 99%
     * - 警告: < 95%
     * - 严重: < 90%
     */
}
```

---

## 4. 告警配置

### 4.1 Prometheus 告警规则

```yaml
# alerting_rules.yml
groups:
  - name: kafka_transaction
    interval: 30s
    rules:
      # 事务成功率告警
      - alert: KafkaTransactionSuccessRateLow
        expr: |
          rate(kafka_producer_tx_commit[5m]) /
          (rate(kafka_producer_tx_commit[5m]) + rate(kafka_producer_tx_abort[5m]))
          < 0.95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka transaction success rate is low"
          description: "Transaction success rate is {{ $value | humanizePercentage }}"

      # 事务超时告警
      - alert: KafkaTransactionTimeoutHigh
        expr: |
          rate(kafka_coordinator_transaction_TransactionTimeoutCount[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka transaction timeout rate is high"
          description: "Transaction timeout rate is {{ $value }} per second"

      # 事务延迟告警
      - alert: KafkaTransactionLatencyHigh
        expr: |
          histogram_quantile(0.95,
            rate(kafka_producer_tx_commit_latency_bucket[5m])
          ) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka transaction latency is high"
          description: "P95 transaction latency is {{ $value }}ms"

      # Producer 冲突告警
      - alert: KafkaProducerFencedHigh
        expr: |
          rate(kafka_producer_errors{type="producer_fenced"}[5m]) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Kafka producer fenced rate is high"
          description: "Producer fenced rate is {{ $value }} per second"
```

### 4.2 Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Kafka Transactions",
    "panels": [
      {
        "title": "Transaction Rate",
        "targets": [
          {
            "expr": "rate(kafka_producer_tx_commit[5m])",
            "legendFormat": "Commit Rate"
          },
          {
            "expr": "rate(kafka_producer_tx_abort[5m])",
            "legendFormat": "Abort Rate"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Transaction Success Rate",
        "targets": [
          {
            "expr": "rate(kafka_producer_tx_commit[5m]) / (rate(kafka_producer_tx_commit[5m]) + rate(kafka_producer_tx_abort[5m]))",
            "legendFormat": "Success Rate"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Transaction Latency",
        "targets": [
          {
            "expr": "histogram_quantile(0.50, rate(kafka_producer_tx_commit_latency_bucket[5m]))",
            "legendFormat": "P50"
          },
          {
            "expr": "histogram_quantile(0.95, rate(kafka_producer_tx_commit_latency_bucket[5m]))",
            "legendFormat": "P95"
          },
          {
            "expr": "histogram_quantile(0.99, rate(kafka_producer_tx_commit_latency_bucket[5m]))",
            "legendFormat": "P99"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Active Transactions",
        "targets": [
          {
            "expr": "kafka_coordinator_transaction_ActiveTransactionCount",
            "legendFormat": "Active"
          }
        ],
        "type": "graph"
      }
    ]
  }
}
```

---

## 5. 监控最佳实践

### 5.1 分层监控

```scala
/**
 * 分层监控策略
 */

object MonitoringLayers {
    /**
     * 1. 应用层监控
     * - 业务指标
     * - 事务成功率
     * - 处理延迟
     */

    /**
     * 2. 客户端监控
     * - Producer 指标
     * - Consumer 指标
     * - 客户端错误
     */

    /**
     * 3. Broker 监控
     * - TransactionCoordinator 指标
     * - 网络指标
     * - 磁盘 I/O
     */

    /**
     * 4. 集群监控
     * - 集群健康
     * - 分区状态
     * - 副本同步
     */
}
```

### 5.2 监控频率

```scala
/**
 * 监控频率建议
 */

object MonitoringFrequency {
    /**
     * 实时指标 (每秒)
     * - 活跃事务数
     * - 事务提交速率
     * - 错误率
     */

    /**
     * 短期指标 (每分钟)
     * - 事务成功率
     * - 平均延迟
     * - 超时次数
     */

    /**
     * 长期指标 (每小时)
     * - 峰值延迟
     * - 资源使用趋势
     * - 容量规划
     */
}
```

### 5.3 告警级别

```scala
/**
 * 告警级别定义
 */

object AlertLevels {
    /**
     * INFO
     * - 事务数量达到阈值
     * - 需要扩容
     */

    /**
     * WARNING
     * - 成功率 < 95%
     * - 延迟 P95 > 500ms
     * - 超时率 > 1%
     */

    /**
     * CRITICAL
     * - 成功率 < 90%
     * - 延迟 P95 > 2000ms
     * - Producer Fence 速率 > 1/s
     */

    /**
     * EMERGENCY
     * - 事务完全失败
     * - Coordinator 不可用
     * - 数据丢失风险
     */
}
```

---

## 6. 故障排查

### 6.1 监控异常分析

```scala
/**
 * 常见监控异常及原因
 */

object CommonIssues {
    /**
     * 1. 事务成功率下降
     * 原因:
     * - 网络问题
     * - Broker 负载过高
     * - 配置错误
     */

    /**
     * 2. 事务延迟增加
     * 原因:
     * - 磁盘 I/O 瓶颈
     * - GC 压力
     * - 网络延迟
     */

    /**
     * 3. Producer Fence 增加
     * 原因:
     * - 应用重启频繁
     * - transactional.id 冲突
     * - 网络分区
     */
}
```

### 6.2 诊断步骤

```scala
/**
 * 故障诊断流程
 */

object DiagnosticSteps {
    /**
     * 步骤 1: 确认影响范围
     * - 单个 Producer?
     * - 所有 Producer?
     * - 特定 Broker?
     */

    /**
     * 步骤 2: 检查日志
     * - Producer 日志
     * - Broker 日志
     * - TransactionCoordinator 日志
     */

    /**
     * 步骤 3: 分析指标
     * - 事务成功率
     * - 延迟分布
     * - 错误类型
     */

    /**
     * 步骤 4: 定位根因
     * - 网络问题
     * - 资源瓶颈
     * - 配置问题
     */
}
```

---

## 7. 总结

### 7.1 关键指标

1. **吞吐量**
   - 事务提交速率
   - 活跃事务数

2. **延迟**
   - P50/P95/P99 延迟
   - Transaction Marker 延迟

3. **可靠性**
   - 事务成功率
   - 超时率
   - 错误率

### 7.2 监控工具

1. **JMX**
   - 原生支持
   - 实时监控

2. **Prometheus + Grafana**
   - 强大的可视化
   - 灵活的告警

3. **Kafka 工具**
   - 性能测试
   - 消息查看

### 7.3 下一步学习

- **[09-transaction-troubleshooting.md](./09-transaction-troubleshooting.md)** - 学习故障排查
- **[10-transaction-config.md](./10-transaction-config.md)** - 了解配置优化

---

**思考题**：
1. 如何区分事务延迟是网络问题还是磁盘问题？
2. Producer Fence 速率高一定有问题吗？为什么？
3. 如何预测事务系统的容量需求？
