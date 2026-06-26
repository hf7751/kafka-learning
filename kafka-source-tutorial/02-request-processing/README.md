# 02. 请求处理机制

## 本章导读

请求处理是 Kafka 的核心功能，负责接收、处理和响应客户端请求。本章节深入分析 Kafka 的网络层架构、请求处理流程和性能优化机制。

## 文档目录

| 文档 | 内容 | 预计阅读时间 |
|------|------|-------------|
| [01-socketserver.md](./01-socketserver.md) | SocketServer 网络层深度解析 | 45 分钟 |
| [02-request-handler.md](./02-request-handler.md) | KafkaApis 请求处理架构 | 40 分钟 |

## 学习路径建议

### 快速了解 (30分钟)
```
1. SocketServer 网络层解析
2. KafkaApis 请求处理
```

### 深入理解 (1.5小时)
```
1. SocketServer 网络层解析 - 理解 Reactor 模式
2. KafkaApis 请求处理 - 理解请求路由机制
```

## 核心概念速查

| 概念 | 说明 | 相关文档 |
|------|------|----------|
| **SocketServer** | 网络层核心组件 | 01-socketserver.md |
| **Acceptor** | 接收新连接的线程 | 01-socketserver.md |
| **Processor** | 处理网络 I/O 的线程 | 01-socketserver.md |
| **RequestChannel** | 请求队列和响应通道 | 01-socketserver.md |
| **KafkaApis** | API 请求处理中心 | 02-request-handler.md |
| **Handler Pool** | 请求处理线程池 | 02-request-handler.md |

## 请求处理流程速查

```
客户端请求处理流程

1. 建立连接
   └── Acceptor 接受新连接
   └── 分配给 Processor

2. 读取请求
   └── Processor 从 Socket 读取
   └── 解析请求头
   └── 完整读取请求体

3. 请求入队
   └── 封装成 RequestChannel.Request
   └── 放入 requestQueue

4. 请求处理
   └── Handler 线程从队列取出
   └── 调用 KafkaApis 处理
   └── 执行业务逻辑

5. 发送响应
   └── 封装成 RequestChannel.Response
   └── 放入 responseQueue
   └── Processor 异步发送

6. 关闭连接
   └── 连接超时或错误
   └── 优雅关闭
```

## 网络层架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Kafka 网络层架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  客户端                                                      │
│     │                                                       │
│     ▼                                                       │
│  ┌─────────────┐                                           │
│  │ Acceptor    │ (NIO Selector, 接受新连接)                │
│  │ Thread(s)   │                                           │
│  └─────┬───────┘                                           │
│        │ 分配连接                                           │
│        ▼                                                    │
│  ┌─────────────────────────────────────┐                   │
│  │  Processor 线程池 (num.network.threads)               │
│  │  ┌──────────┐  ┌──────────┐       │                   │
│  │  │Processor1│  │Processor2│  ...  │                   │
│  │  └────┬─────┘  └────┬─────┘       │                   │
│  └───────┼────────────┼───────────────┘                   │
│          │            │                                    │
│          ▼            ▼                                    │
│     ┌──────────────────────────────┐                       │
│     │   RequestChannel             │                       │
│     │  ┌────────────┐  ┌───────────┐│                    │
│     │  │requestQueue│  │responseQueue││                   │
│     │  └─────┬──────┘  └─────┬─────┘│                    │
│     └──────────┼─────────────┼───────┘                    │
│                │             │                             │
│                ▼             ▼                             │
│     ┌──────────────────────────────────┐                   │
│     │  KafkaRequestHandlerPool         │                   │
│     │  ┌────────┐  ┌────────┐          │                   │
│     │  │Handler1│  │Handler2│  ...     │                   │
│     │  └───┬────┘  └───┬────┘          │                   │
│     └──────┼───────────┼───────────────┘                   │
│            │           │                                    │
│            ▼           ▼                                    │
│     ┌──────────────────────────────────┐                   │
│     │       KafkaApis                  │                   │
│     │  (处理所有 API 请求)             │                   │
│     └──────────────────────────────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 关键源码路径

```
网络层
├── kafka/network/
│   ├── SocketServer.scala              # 网络服务器
│   ├── Acceptor.scala                  # 连接接受器
│   ├── Processor.scala                 # 网络处理器
│   ├── RequestChannel.scala            # 请求通道
│   └── SocketServer.scala              # 网络层主类

请求处理
├── kafka/server/
│   ├── KafkaApis.scala                 # API 处理中心
│   ├── KafkaRequestHandler.scala       # 请求处理器
│   └── KafkaRequestHandlerPool.scala   # 处理器线程池
```

## 关键配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `num.network.threads` | 3 | 网络线程数（Processor） |
| `num.io.threads` | 8 | I/O 处理线程数 |
| `socket.send.buffer.bytes` | 102400 | Socket 发送缓冲区 |
| `socket.receive.buffer.bytes` | 102400 | Socket 接收缓冲区 |
| `socket.request.max.bytes` | 104857600 | 请求最大字节数 |
| `connections.max.idle.ms` | 600000 | 空闲连接超时 |
| `max.connections.per.ip` | ∞ | 单IP最大连接数 |

详细配置参数请参考文档内容。

## 版本说明

- **Kafka 版本**：4.x
- **Reactor 模式**：NIO Selector
- **最后更新**：2026-03-02

## 相关章节

- **上一章**：[01-server-startup](../01-server-startup/README.md) - 服务端启动
- **下一章**：[03-log-storage](../03-log-storage/README.md) - 日志存储

---

**快速开始**：建议从 [01-socketserver.md](./01-socketserver.md) 开始阅读
