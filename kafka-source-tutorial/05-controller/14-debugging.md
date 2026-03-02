# 14. 调试技巧

> **本文档导读**
>
> 本文档介绍 KRaft 的调试技巧和工具。
>
> **预计阅读时间**: 25 分钟
>
> **相关文档**:
> - [03-quorum-controller.md](./03-quorum-controller.md) - QuorumController 核心实现
> - [11-troubleshooting.md](./11-troubleshooting.md) - 故障排查指南

---

## 14. 调试技巧

### 14.1 开启调试日志

```properties
# log4j.properties

# Controller 相关日志
log4j.logger.kafka.controller=DEBUG, controllerAppender
log4j.logger.kafka.raft=DEBUG, raftAppender

# Raft 协议日志
log4j.logger.org.apache.kafka.raft=DEBUG, raftAppender

# 元数据日志
log4j.logger.org.apache.kafka.image=DEBUG, metadataAppender

# Appender 配置
log4j.appender.controllerAppender=org.apache.log4j.DailyRollingFileAppender
log4j.appender.controllerAppender.DatePattern='.'yyyy-MM-dd
log4j.appender.controllerAppender.File=/tmp/kraft-logs/controller.log
log4j.appender.controllerAppender.layout=org.apache.log4j.PatternLayout
log4j.appender.controllerAppender.layout.ConversionPattern=%d{ISO8601} [%t] %-5p %c{2} - %m%n
```

### 14.2 常用调试命令

```bash
# 1. 查看当前 Leader
bin/kafka-metadata-quorum.sh describe --status

# 2. 查看 Raft 日志
bin/kafka-metadata-shell.sh --snapshot /path/to/snapshot

# 3. 实时监控 Controller 事件
tail -f /tmp/kraft-combined-logs/server.log | grep -i "controller\|raft"

# 4. 检查元数据版本
bin/kafka-metadata-shell.sh --snapshot <snapshot-file> --batch 0 --count 1

# 5. 验证配置
bin/kafka-configs.sh --bootstrap-server localhost:9092 --describe

# 6. 监控 JMX 指标
jconsole &
# 连接到 localhost:9092
# 浏览 MBeans: kafka.controller, kafka.raft

# 7. 分析线程堆栈
jps | grep Kafka
jstack <pid> > thread_dump.txt
cat thread_dump.txt | grep -A 20 "controller-event-processor"

# 8. 查看网络连接
netstat -an | grep 9093
ss -tuln | grep 9093
```

### 14.3 问题诊断流程图

```
┌─────────────────────────────────────────────────────────────┐
│                    Controller 问题诊断流程                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  问题现象                                                   │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐                                           │
│  │ 检查基础状态 │                                           │
│  │ - 服务运行? │                                           │
│  │ - 端口监听? │                                           │
│  │ - 日志错误? │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │ 检查网络    │                                           │
│  │ - 连通性    │                                           │
│  │ - 防火墙    │                                           │
│  │ - DNS       │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │ 检查配置    │                                           │
│  │ - voters配置│                                           │
│  │ - node.id   │                                           │
│  │ - listeners │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │ 检查资源    │                                           │
│  │ - 磁盘空间  │                                           │
│  │ - 内存      │                                           │
│  │ - CPU       │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │ 检查元数据  │                                           │
│  │ - 日志文件  │                                           │
│  │ - 快照文件  │                                           │
│  │ - 一致性    │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │ 检查 Raft   │                                           │
│  │ - Leader选举│                                           │
│  │ - 日志复制  │                                           │
│  │ - 提交延迟  │                                           │
│  └──────┬──────┘                                           │
│         │                                                  │
│         ▼                                                  │
│    应用解决方案                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---
