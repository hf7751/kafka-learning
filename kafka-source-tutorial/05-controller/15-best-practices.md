# 15. 最佳实践

> **本文档导读**
>
> 本文档总结生产环境的最佳实践。
>
> **预计阅读时间**: 35 分钟
>
> **相关文档**:
> - [16-security.md](./16-security.md) - 安全配置
> - [17-backup-recovery.md](./17-backup-recovery.md) - 备份与恢复

---

## 15. 最佳实践

### 15.1 生产环境部署建议

```scala
/**
 * 1. Controller 与 Broker 分离
 *
 * 优势:
 * - 职责分离，便于独立扩展
 * - 资源隔离，避免相互影响
 * - 便于监控和运维
 *
 * 推荐:
 * - Controller: 3-5 个专用节点
 * - Broker: 根据负载配置
 */
```

```properties
# Controller 节点配置
process.roles=controller
node.id=1
listeners=CONTROLLER://:9093
controller.quorum.voters=1@ctrl1:9093,2@ctrl2:9093,3@ctrl3:9093

# Broker 节点配置
process.roles=broker
node.id=10
listeners=PLAINTEXT://:9092
controller.quorum.voters=1@ctrl1:9093,2@ctrl2:9093,3@ctrl3:9093
```

### 15.2 容量规划

```
┌─────────────────────────────────────────────────────────────┐
│                    Controller 容量规划                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 硬件资源                                                │
│     ├── CPU: 4 核心 (处理元数据请求)                        │
│     ├── 内存: 4GB (元数据缓存 + JVM 堆)                    │
│     ├── 磁盘: 100GB SSD (元数据日志 + 快照)                 │
│     └── 网络: 1Gbps (Raft 复制流量)                        │
│                                                             │
│  2. 容量评估                                                │
│     ├── 单个 Topic: ~1KB 元数据                            │
│     ├── 单个分区: ~500B 元数据                             │
│     ├── 10000 Topics / 100000 Partitions                    │
│     │   → ~50MB 元数据                                      │
│     └── 元数据变更速率: ~100 ops/s                          │
│                                                             │
│  3. 网络带宽                                                │
│     ├── Raft 复制流量: ~10MB/s                             │
│     ├── 心跳流量: ~1KB/s per connection                    │
│     └── 元数据发布流量: ~5MB/s                             │
│                                                             │
│  4. 存储增长                                                │
│     ├── 元数据日志: ~1GB/天                                │
│     ├── 快照文件: ~50MB/个                                 │
│     └── 保留策略: 定期清理旧快照                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 15.3 安全配置

```properties
# ==================== 启用 SSL/TLS ====================
# Controller 监听器
listeners=CONTROLLER://:9093
controller.listener.names=CONTROLLER
listener.security.protocol.map=CONTROLLER:SSL

# SSL 配置
ssl.keystore.location=/path/to/keystore.jks
ssl.keystore.password=password
ssl.truststore.location=/path/to/truststore.jks
ssl.truststore.password=password

# ==================== 启用 ACL ====================
# 启用 ACL
authorizer.class.name=kafka.security.authorizer.AclAuthorizer

# Controller 操作权限
# CreateTopics, DeleteTopics, AlterConfigs
super.users=User:admin

# ==================== 网络隔离 ====================
# 限制 Controller 监听器访问
# 通过防火墙规则
# 只允许 Broker 和 Controller 之间通信
```

### 15.4 备份与恢复

```bash
# ==================== 元数据备份 ====================

# 1. 备份元数据快照
cp -r /tmp/kraft-combined-logs/metadata /backup/metadata-$(date +%Y%m%d)

# 2. 导出元数据到 JSON
bin/kafka-metadata-shell.sh --snapshot <snapshot-file> --export metadata-backup.json

# 3. 定期备份脚本
#!/bin/bash
BACKUP_DIR="/backup/kafka-metadata"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
kafka-metadata-shell.sh --snapshot /tmp/kraft-combined-logs/metadata/__cluster_metadata-0/*.snapshot \
  --export $BACKUP_DIR/metadata_$DATE.json

# 保留最近 7 天的备份
find $BACKUP_DIR -name "metadata_*.json" -mtime +7 -delete

# ==================== 元数据恢复 ====================

# 1. 从快照恢复
# 停止所有节点
bin/kafka-server-stop.sh

# 清理元数据目录
rm -rf /tmp/kraft-combined-logs/metadata

# 恢复快照
cp -r /backup/metadata-20250301/* /tmp/kraft-combined-logs/metadata/

# 重新启动
bin/kafka-server-start.sh -daemon config/kraft/server.properties

# 2. 从 JSON 导入 (需要自定义工具)
# kafka-metadata-import.sh --import metadata-backup.json
```

---
