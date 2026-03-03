# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 Kafka 源码分析教程项目，提供深入浅出的 Kafka 源码解析文档。项目包含 87+ 个 Markdown 文档，涵盖 Kafka 3.x 的核心实现机制。

## 项目结构

```
kafka-learning/
├── kafka-source-tutorial/      # 主教程目录
│   ├── 00-intro/               # 入门介绍（架构、源码结构、调试环境）
│   ├── 01-server-startup/      # 服务启动流程
│   ├── 02-request-processing/  # 请求处理（SocketServer、KafkaApis）
│   ├── 03-log-storage/         # 日志存储（核心性能优化）
│   ├── 04-replica-management/  # 副本管理（ISR、选举）
│   ├── 05-controller/          # KRaft Controller（20个文档）
│   ├── 06-coordinator/         # 协调器（Consumer Group）
│   ├── 07-transaction/         # 事务机制
│   └── 08-other/               # 其他（Raft 协议通俗教程）
└── .qoder/                     # Qoder 工具生成的文件（已 gitignore）
```

## 文档编写约定

### Markdown 格式规范
- 使用中文编写所有技术文档
- 使用 Mermaid 图表展示架构和流程
- 代码块使用 scala/java 高亮
- 表格用于对比和配置说明
- 使用 emoji 区分重要程度（⭐ 表示推荐，✅ 表示完成）

### 文档结构模板
```markdown
# 标题

## 目录
- [1. 小节](#1-小节)

## 1. 小节
### 1.1 子小节
内容...

> 💡 **提示**：补充说明

| 属性 | 说明 |
|-----|------|
| key | value |
```

### 术语一致性
- KRaft：Kafka Raft 模式的官方名称（大写 K、R）
- Broker：Kafka 服务节点
- Topic/Partition：使用英文
- ISR：In-Sync Replicas 首次出现全称，后续可用缩写
- Leader/Follower：副本角色

## 常用命令

### 文档验证
```bash
# 检查 Markdown 语法（需要 markdownlint）
npx markdownlint kafka-source-tutorial/**/*.md

# 统计文档数量
find kafka-source-tutorial -name "*.md" | wc -l

# 检查中文链接有效性
grep -r "\.md" kafka-source-tutorial --include="*.md"
```

### Git 操作
```bash
# 提交文档更新
git add kafka-source-tutorial/
git commit -m "docs: 更新 xxx 文档"

# 查看修改
git diff kafka-source-tutorial/
```

## 核心技术概念

### Kafka 架构要点
1. **KRaft 模式**：Kafka 3.x 默认使用 Raft 协议替代 ZooKeeper
2. **分层架构**：网络层 → 调度层 → 应用层 → 存储层
3. **性能核心**：顺序写、零拷贝（sendfile）、页缓存
4. **可靠性**：ISR 机制、副本同步、HW/LEO 管理

### 关键类名（Scala/Java）
- `KafkaServer`：Broker 启动入口
- `SocketServer`：Reactor 网络层
- `KafkaApis`：请求路由和处理
- `LogManager`：日志管理
- `ReplicaManager`：副本管理
- `QuorumController`：KRaft Controller 核心
- `GroupCoordinator`：消费者组协调器

## 文档质量标准

### 评分维度（目标 9.5+/10）
- **内容准确性**：技术描述准确，概念正确
- **表达流畅性**：中文自然流畅，术语统一
- **格式规范性**：Markdown 语法正确，代码块规范
- **实用性**：配置详尽，案例丰富
- **完整性**：覆盖全面，无缺失

### 必读文档（9.5+ 分）
- `08-other/raft-protocol-explained.md`：Raft 协议通俗教程
- `05-controller/01-krft-overview.md`：KRaft 架构完整说明
- `02-request-processing/01-socketserver.md`：网络层深度解析
- `04-replica-management/01-replica-manager.md`：副本管理完整

## 开发注意事项

### 不应包含的内容
- 通用开发实践（如 "写单元测试"）
- 明显的提示（如 "提供有用的错误信息"）
- 不基于项目实际情况的虚构命令

### .gitignore 已配置
- `.claude/`：Claude Code 相关文件
- `output/`：输出文件和报告
- `kafka/`：Kafka 源码目录
- `.qoder/`：Qoder 工具生成文件
