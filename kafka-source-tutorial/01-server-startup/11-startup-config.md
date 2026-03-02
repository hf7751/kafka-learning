# 启动配置详解

## 本章导读

本文档详细说明 Kafka 启动相关的配置参数，包括必需配置、可选配置和性能调优配置。

**预计阅读时间**：25 分钟
**相关文档**：[启动概述](./01-startup-overview.md) | [启动调优](./12-startup-tuning.md)

---

## 1. 必需配置参数

### 1.1 KRaft 模式必需配置

```properties
# ==================== 身份配置 ====================
# 节点角色（必需）
process.roles=broker,controller

# 节点ID（必需）
node.id=1

# Controller 集群成员列表（必需）
controller.quorum.voters=1@localhost:9093,2@localhost:9094,3@localhost:9095

# ==================== 监听器配置 ====================
# 监听器名称（必需）
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT

# 监听器地址（必需）
listeners=PLAINTEXT://:9092,CONTROLLER://:9093

# Controller 监听器名称（必需）
controller.listener.names=CONTROLLER

# ==================== 存储配置 ====================
# 日志目录（必需）
log.dirs=/tmp/kafka-logs
```

### 1.2 参数说明

#### process.roles

定义节点的角色，可以是一个或多个：

```properties
# 纯 Broker
process.roles=broker

# 纯 Controller
process.roles=controller

# 混合模式（开发/测试）
process.roles=broker,controller
```

**生产环境建议**：
- 小规模集群（< 10 个 Broker）：使用混合模式
- 大规模集群（> 10 个 Broker）：分离 Broker 和 Controller

#### node.id

节点的唯一标识符，必须是整数：

```properties
# 每个节点必须有唯一的 ID
node.id=1

# 集群内不允许重复
# node.id=1  # 错误：多个节点使用相同 ID
```

**注意事项**：
- 一旦分配，不应更改
- 范围：0 到 2^31-1
- 建议连续编号便于管理

#### controller.quorum.voters

定义 Controller 集群的成员：

```properties
# 格式: nodeId@host:port
controller.quorum.voters=1@controller1.example.com:9093,2@controller2.example.com:9093,3@controller3.example.com:9093

# 本地开发
controller.quorum.voters=1@localhost:9093

# 多数据中心
controller.quorum.voters=1@dc1-controller1:9093,2@dc1-controller2:9093,3@dc2-controller1:9093
```

**关键点**：
- 所有 Controller 节点必须列在其中
- 使用 Controller 监听器端口（默认 9093）
- 必须在所有节点上配置相同

---

## 2. 网络配置

### 2.1 监听器配置详解

```properties
# ==================== 基础监听器配置 ====================
# 定义协议映射
listener.security.protocol.map=CONTROLLER:PLAINTEXT,BROKER:PLAINTEXT,PLAINTEXT:PLAINTEXT

# 监听器列表
listeners=BROKER://:9092,CONTROLLER://:9093

# 广播地址（集群环境必需）
advertised.listeners=BROKER://broker1.example.com:9092

# Broker 间通信监听器
inter.broker.listener.name=BROKER

# ==================== 安全监听器配置 ====================
# SSL 配置
listener.security.protocol.map=CONTROLLER:SSL,BROKER:SSL,SSL:SSL
listeners=BROKER://:9092,CONTROLLER://:9093
ssl.keystore.location=/path/to/keystore.jks
ssl.keystore.password=password
ssl.truststore.location=/path/to/truststore.jks
ssl.truststore.password=password

# SASL 配置
listener.security.protocol.map=BROKER:SASL_PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT
listeners=BROKER://:9092
sasl.mechanism.inter.broker.protocol=PLAIN
sasl.enabled.mechanisms=PLAIN
```

### 2.2 监听器配置示例

#### 开发环境配置

```properties
# 单节点开发环境
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@localhost:9093
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
controller.listener.names=CONTROLLER
log.dirs=/tmp/kafka-logs
```

#### 生产环境配置

```properties
# Broker 节点配置
process.roles=broker
node.id=10
controller.quorum.voters=1@ctrl1.example.com:9093,2@ctrl2.example.com:9093,3@ctrl3.example.com:9093
listeners=SECURE://:9092
advertised.listeners=SECURE://broker1.example.com:9092
listener.security.protocol.map=SECURE:SSL
inter.broker.listener.name=SECURE
ssl.keystore.location=/etc/kafka/keystore.jks
ssl.keystore.password=${file:/etc/kafka/keystore.password}
log.dirs=/data/kafka/logs

# Controller 节点配置
process.roles=controller
node.id=1
controller.quorum.voters=1@ctrl1.example.com:9093,2@ctrl2.example.com:9093,3@ctrl3.example.com:9093
listeners=CONTROLLER://:9093
listener.security.protocol.map=CONTROLLER:SSL
controller.listener.names=CONTROLLER
log.dirs=/data/kafka/controller-metadata
```

---

## 3. 存储配置

### 3.1 日志目录配置

```properties
# 单一路径
log.dirs=/data/kafka/logs

# 多路径（推荐，提高 I/O 性能）
log.dirs=/data1/kafka/logs,/data2/kafka/logs,/data3/kafka/logs

# 不同类型数据的分离
log.dirs=/data/kafka/datalogs,/ssd/kafka/metadata
```

### 3.2 日志清理配置

```properties
# ==================== 基于时间的清理 ====================
# 日志保留时间（小时）
log.retention.hours=168

# 或使用分钟
# log.retention.minutes=10080

# 或使用毫秒
# log.retention.ms=604800000

# ==================== 基于大小的清理 ====================
# 每个 Topic 的最大大小
log.retention.bytes=1073741824

# 或使用 -1 表示无限制
# log.retention.bytes=-1

# ==================== 日志段配置 ====================
# 段文件大小
log.segment.bytes=1073741824

# 滚动时间（毫秒）
log.roll.ms=604800000

# ==================== 清理策略 ====================
# 清理策略：delete（删除）或 compact（压缩）
log.cleanup.policy=delete

# 或同时使用
# log.cleanup.policy=compact,delete

# 清理线程数
log.cleaner.threads=8

# 清理缓冲区大小
log.cleaner.dedupe.buffer.size=134217728
```

### 3.3 磁盘空间管理

```properties
# ==================== 磁盘使用限制 ====================
# 日志目录使用阈值
log.d reserved=1073741824

# 磁盘空间警告阈值（比例）
log.disk.usage.threshold.ltz=0.9

# 磁盘空间警告阈值（字节数）
log.disk.usage.threshold.bytes=10737418240
```

---

## 4. 性能配置

### 4.1 线程配置

```properties
# ==================== 网络线程 ====================
# 网络处理线程数
num.network.threads=8

# I/O 线程数
num.io.threads=16

# 后台线程数
background.threads=10

# ==================== 请求处理 ====================
# 请求最大字节数
socket.request.max.bytes=104857600

# socket 发送缓冲区
socket.send.buffer.bytes=102400

# socket 接收缓冲区
socket.receive.buffer.bytes=102400

# socket 请求超时
socket.request.timeout.ms=30000
```

### 4.2 批量配置

```properties
# ==================== 生产者批量 ====================
# 批量大小
batch.size=16384

# 批量延迟
linger.ms=0

# ==================== 消费者拉取 ====================
# 最小拉取字节数
fetch.min.bytes=1

# 最大拉取字节数
fetch.max.bytes=52428800

# 最大等待时间
fetch.max.wait.ms=500
```

### 4.3 副本配置

```properties
# ==================== 副本同步 ====================
# 默认副本数
default.replication.factor=3

# 最小同步副本数
min.insync.replicas=2

# ISR 扩展比例
replica.fetch.max.bytes=1048576

# 副本拉取超时
replica.fetch.wait.max.ms=500

# ==================== Leader 选举 ====================
# 自动 Leader 再平衡
auto.leader.rebalance.enable=true

# 不清洁 Leader 选举
unclean.leader.election.enable=false
```

---

## 5. Controller 配置

### 5.1 Raft 配置

```properties
# ==================== 选举配置 ====================
# 选举超时（毫秒）
controller.quorum.election.timeout.ms=1000

# 心跳间隔（毫秒）
controller.quorum.heartbeat.interval.ms=500

# 请求超时（毫秒）
controller.quorum.request.timeout.ms=2000

# ==================== 快照配置 ====================
# 快照间隔（字节）
metadata.log.max.snapshot.interval.bytes=52428800

# 快照之间最大记录数
metadata.log.max.record.bytes.between.snapshots=20000

# 快照缓存大小
metadata.log.max.snapshot.cache.size=3
```

### 5.2 元数据配置

```properties
# ==================== 元数据发布 ====================
# 发布延迟（毫秒）
metadata.publisher.max.delay.ms=50

# 最大元数据年龄（毫秒）
metadata.max.idleness.interval.ms=5000

# ==================== 元数据加载 ====================
# 最大加载延迟（毫秒）
metadata.load.max.delay.ms=60000
```

---

## 6. 监控配置

### 6.1 指标配置

```properties
# ==================== 指标报告 ====================
# 指标报告器列表
metric.reporters=com.example.CustomMetricsReporter

# JMX 端口
# 在 kafka-run-class.sh 中设置：KAFKA_JMX_OPTS=-Dcom.sun.management.jmxremote

# ==================== 指标采样 ====================
# 指标采样间隔（毫秒）
metric.sample.period.ms=10000

# 指标过期时间（毫秒）
metric.record.level.ms=60000
```

### 6.2 日志配置

```properties
# ==================== 日志级别 ====================
# 在 log4j.properties 中配置
log4j.rootLogger=INFO, stdout

# Controller 日志
log4j.logger.kafka.controller=DEBUG

# Raft 日志
log4j.logger.kafka.raft=DEBUG

# ==================== 日志输出 ====================
# 日志目录
log.dirs=/var/log/kafka

# 单个日志文件大小
log4j.appender.kafkaAppender.MaxFileSize=100MB

# 保留的日志文件数量
log4j.appender.kafkaAppender.MaxBackupIndex=10
```

---

## 7. 安全配置

### 7.1 SSL/TLS 配置

```properties
# ==================== SSL 基础配置 ====================
# 启用 SSL
ssl.enabled.protocols=TLSv1.2,TLSv1.3

# SSL 密码套件
ssl.cipher.suites=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

# 密钥库配置
ssl.keystore.type=JKS
ssl.keystore.location=/path/to/keystore.jks
ssl.keystore.password=password
ssl.key.password=password

# 信任库配置
ssl.truststore.type=JKS
ssl.truststore.location=/path/to/truststore.jks
ssl.truststore.password=password

# 客户端认证
ssl.client.auth=required
```

### 7.2 SASL 配置

```properties
# ==================== SASL 机制 ====================
# 启用的 SASL 机制
sasl.enabled.mechanisms=PLAIN,SCRAM-SHA-256,SCRAM-SHA-512

# Broker 间机制
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-256

# ==================== JAAS 配置 ====================
# 在 kafka_server_jaas.conf 中配置
KafkaServer {
   org.apache.kafka.common.security.scram.ScramLoginModule required
   username="kafka"
   password="kafka-secret";
};

# ==================== SASL 配置 ====================
# SASL 回调处理
sasl.server.callback.handler.class=org.apache.kafka.common.security.auth.PlainServerCallbackHandler
```

### 7.3 ACL 配置

```properties
# ==================== ACL 配置 ====================
# 启用 ACL
authorizer.class.name=kafka.security.authorizer.AclAuthorizer

# 超级用户
super.users=User:admin;User:alice

# 允许所有人都删除
allow.everyone.if.no.acl.found=false
```

---

## 8. 环境变量配置

### 8.1 JVM 配置

```bash
# ==================== 堆内存配置 ====================
# 在 kafka-server-start.sh 中设置
export KAFKA_HEAP_OPTS="-Xms4g -Xmx4g"

# ==================== GC 配置 ====================
export KAFKA_HEAP_OPTS="-Xms4g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=20"

# ==================== 性能优化 ====================
export KAFKA_JVM_PERFORMANCE_OPTS="-server -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=20 -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:+ExplicitGCInvokesConcurrent -Djava.awt.headless=true"

# ==================== JMX 配置 ====================
export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false \
  -Dcom.sun.management.jmxremote.port=9999"
```

### 8.2 日志配置

```bash
# ==================== 日志配置 ====================
export LOG_DIR=/var/log/kafka

export KAFKA_LOG4J_OPTS="-Dlog4j.configuration=file:/etc/kafka/log4j.properties"
```

---

## 9. 配置验证

### 9.1 配置检查工具

```bash
# 验证配置文件
bin/kafka-server-start.sh --daemon config/kraft/server.properties \
  --override log.dirs=/tmp/kafka-test \
  --verify

# 检查特定配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --describe --entity-type brokers
```

### 9.2 配置最佳实践检查清单

```
配置检查清单:
┌─────────────────────────────────────────────────────────────┐
│  □ node.id 在集群中唯一                                      │
│  □ controller.quorum.voters 在所有节点上一致                 │
│  □ listeners 配置正确的协议和端口                            │
│  □ advertised.listeners 配置集群可达地址                     │
│  □ log.dirs 目录存在且有写权限                               │
│  □ JVM 堆内存合理设置（通常 4-6GB）                           │
│  □ 副本数 >= 3 且 min.insync.replicas = 2                   │
│  □ 日志保留时间根据业务需求设置                               │
│  □ 监控和日志已正确配置                                      │
│  □ 安全配置已启用（生产环境）                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. 配置模板

### 10.1 开发环境模板

```properties
# 开发环境最小配置
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@localhost:9093
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
controller.listener.names=CONTROLLER
log.dirs=/tmp/kafka-logs
num.partitions=1
default.replication.factor=1
log.retention.hours=168
```

### 10.2 生产环境模板

```properties
# 生产环境推荐配置
process.roles=broker
node.id=10
controller.quorum.voters=1@ctrl1.example.com:9093,2@ctrl2.example.com:9093,3@ctrl3.example.com:9093
listeners=SECURE://:9092
advertised.listeners=SECURE://broker1.example.com:9092
listener.security.protocol.map=SECURE:SSL
inter.broker.listener.name=SECURE
log.dirs=/data1/kafka/logs,/data2/kafka/logs
num.network.threads=8
num.io.threads=16
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400
socket.request.max.bytes=104857600
num.partitions=16
default.replication.factor=3
min.insync.replicas=2
log.retention.hours=168
log.segment.bytes=1073741824
log.retention.check.interval.ms=300000
zookeeper.connect=null
ssl.keystore.location=/etc/kafka/keystore.jks
ssl.keystore.password=${file:/etc/kafka/keystore.password}
ssl.truststore.location=/etc/kafka/truststore.jks
ssl.truststore.password=${file:/etc/kafka/truststore.password}
```

---

**相关配置**:
- [性能调优](./12-startup-tuning.md)
- [故障排查](./10-startup-troubleshooting.md)
- [操作指南](./09-startup-operations.md)
