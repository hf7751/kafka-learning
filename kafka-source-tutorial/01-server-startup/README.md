# 01. Kafka 服务端启动流程

## 本章导读

本章深入分析 Kafka 服务的启动流程，从 main() 方法到服务就绪的完整过程。通过源码分析，我们了解 Kafka 各个组件是如何初始化和协同工作的。

## 文档目录

| 文档 | 内容 | 预计阅读时间 |
|------|------|-------------|
| [01-startup-overview.md](./01-startup-overview.md) | 启动流程概述、入口点分析 | 20 分钟 |
| [02-kafkaserver-startup.md](./02-kafkaserver-startup.md) | KafkaServer 启动流程详解 | 30 分钟 |
| [03-startup-config.md](./03-startup-config.md) | 启动配置详解 | 25 分钟 |

## 学习路径建议

### 快速了解 (30分钟)
```
1. 启动流程概述 (01-startup-overview.md)
2. 启动配置详解 (03-startup-config.md)
```

### 深入理解 (1小时)
```
1. 启动流程概述 (01-startup-overview.md)
2. KafkaServer 启动流程 (02-kafkaserver-startup.md)
3. 启动配置详解 (03-startup-config.md)
```

## 核心概念速查

| 概念 | 说明 | 相关文档 |
|------|------|----------|
| **KafkaRaftServer** | KRaft 模式的服务器入口 | 02-kafkaserver-startup.md |
| **BrokerServer** | Broker 角色的服务器 | 02-kafkaserver-startup.md |
| **ControllerServer** | Controller 角色的服务器 | 02-kafkaserver-startup.md |
| **meta.properties** | 存储节点 ID 和集群 ID 的文件 | 01-startup-overview.md |
| **process.roles** | 定义节点角色 (broker/controller) | 03-startup-config.md |

## 启动流程速查

```
1. 配置加载
   └── 解析 server.properties

2. 日志目录初始化
   └── 验证/创建 meta.properties

3. SharedServer 创建
   └── 初始化共享组件 (Metrics, MetricsReporter)

4. 角色判断
   ├── Controller → ControllerServer
   └── Broker → BrokerServer

5. 核心组件初始化
   ├── SocketServer
   ├── LogManager
   ├── ReplicaManager
   └── ...

6. 服务启动
   ├── 启动网络层
   ├── 注册到 Controller
   └── 等待就绪

7. 接受请求
   └── 开始处理客户端请求
```

## 关键源码路径

```
启动入口:
├── core/src/main/scala/kafka/Kafka.scala          # main() 入口
└── core/src/main/scala/kafka/server/

服务器实现:
├── KafkaRaftServer.scala                           # KRaft 服务器
├── SharedServer.scala                              # 共享服务器
├── BrokerServer.scala                              # Broker 服务器
└── ControllerServer.scala                          # Controller 服务器

核心组件:
├── SocketServer.scala                              # 网络层
├── LogManager.scala                                # 日志管理
├── ReplicaManager.scala                            # 副本管理
└── KafkaApis.scala                                 # 请求处理
```

## 常见启动参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `process.roles` | - | 节点角色：broker, controller |
| `node.id` | - | 节点唯一 ID |
| `controller.quorum.voters` | - | Controller 集群成员 |
| `log.dirs` | /tmp/kafka-logs | 日志目录 |
| `listeners` | - | 监听地址列表 |
| `inter.broker.listener.name` | - | Broker 间通信监听器 |

更多配置参数请参考：[03-startup-config.md](./03-startup-config.md)

## 版本说明

- **Kafka 版本**: 3.7.0+
- **启动模式**: KRaft 模式
- **最后更新**: 2026-03-02

## 相关章节

- **上一章**: [00-intro](../00-intro/README.md) - 介绍与架构
- **下一章**: [02-request-processing](../02-request-processing/README.md) - 请求处理

---

**快速开始**: 建议从 [01-startup-overview.md](./01-startup-overview.md) 开始阅读
