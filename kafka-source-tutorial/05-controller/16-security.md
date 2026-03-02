# 16. 安全配置与权限管理

> **本文档导读**
>
> 本文档介绍 KRaft 模式的安全配置，包括认证、授权和加密。
>
> **预计阅读时间**: 20 分钟
>
> **相关文档**:
> - [15-best-practices.md](./15-best-practices.md) - 最佳实践
> - [12-configuration.md](./12-configuration.md) - 配置参数详解

---

## 1. 安全概述

### 1.1 安全层次

```scala
/**
 * Kafka KRaft 安全层次:
 *
 * 1. 网络层
 *    - SSL/TLS 加密
 *    - 端口监听控制
 *
 * 2. 认证层
 *    - SASL 认证
 *    - SSL 证书认证
 *
 * 3. 授权层
 *    - ACL (Access Control List)
 *    - 基于角色的权限控制
 *
 * 4. 审计层
 *    - 操作日志
 *    - 审计追踪
 */
```

### 1.2 安全配置流程

```mermaid
graph LR
    A[配置 SSL/TLS] --> B[配置 SASL 认证]
    B --> C[配置 ACL 授权]
    C --> D[配置审计日志]
    D --> E[验证安全配置]
```

---

## 2. SSL/TLS 加密

### 2.1 生成证书

```bash
# ==================== 生成 CA 证书 ====================

# 1. 生成 CA 私钥
openssl genpkey -algorithm RSA -out ca-key.pem -pkeyopt rsa_keygen_bits:2048

# 2. 生成 CA 证书
openssl req -new -x509 -key ca-key.pem -out ca-cert.pem -days 365 \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=MyCompany/CN=MyCA"

# ==================== 生成服务器证书 ====================

# 1. 生成服务器私钥
openssl genpkey -algorithm RSA -out server-key.pem -pkeyopt rsa_keygen_bits:2048

# 2. 生成服务器证书签名请求 (CSR)
openssl req -new -key server-key.pem -out server-csr.pem \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=MyCompany/CN=kafka-server"

# 3. 用 CA 签名服务器证书
openssl x509 -req -in server-csr.pem -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert.pem -days 365

# 4. 生成客户端证书
openssl genpkey -algorithm RSA -out client-key.pem -pkeyopt rsa_keygen_bits:2048
openssl req -new -key client-key.pem -out client-csr.pem \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=MyCompany/CN=kafka-client"
openssl x509 -req -in client-csr.pem -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out client-cert.pem -days 365

# ==================== 转换证书格式 ====================

# 转换为 PKCS12 格式 (Java keystore)
openssl pkcs12 -export -in server-cert.pem -inkey server-key.pem \
  -out server.keystore.p12 -name kafka-server \
  -CAfile ca-cert.pem -caname root -password pass:serverpass

# 创建信任库
keytool -import -file ca-cert.pem -keystore server.truststore.jks \
  -alias CARoot -storepass truststorepass -noprompt
```

### 2.2 配置 SSL

```properties
# ==================== Controller SSL 配置 ====================

# 监听器配置
listeners=SSL://:9092,CONTROLLER://:9093
inter.broker.listener.name=SSL

# SSL Keystore (服务器证书)
ssl.keystore.type=PKCS12
ssl.keystore.location=/path/to/server.keystore.p12
ssl.keystore.password=serverpass

# SSL Truststore (CA 证书)
ssl.truststore.type=JKS
ssl.truststore.location=/path/to/server.truststore.jks
ssl.truststore.password=truststorepass

# SSL 协议和加密套件
ssl.protocol=TLSv1.3
ssl.enabled.protocols=TLSv1.3,TLSv1.2
ssl.cipher.suites=TLS_AES_256_GCM_SHA384,TLS_AES_128_GCM_SHA256

# 客户端认证
ssl.client.auth=required
ssl.key.password=serverpass

# 端点识别
ssl.endpoint.identification.algorithm=https
```

---

## 3. SASL 认证

### 3.1 SASL PLAIN 认证

```properties
# ==================== SASL PLAIN 配置 ====================

# 启用 SASL
listeners=SASL_SSL://:9092,CONTROLLER://:9093
security.inter.broker.protocol=SASL_SSL

# 启用 PLAIN 机制
sasl.enabled.mechanisms=PLAIN
sasl.mechanism.inter.broker.protocol=PLAIN

# JAAS 配置文件
# kafka_server_jaas.conf:
KafkaServer {
   org.apache.kafka.common.security.plain.PlainLoginModule required
   username="controller"
   password="controller-secret";
};

# 启动参数
export KAFKA_OPTS="-Djava.security.auth.login.config=/path/to/kafka_server_jaas.conf"
```

### 3.2 SASL SCRAM 认证

```bash
# ==================== 创建 SCRAM 用户 ====================

# 创建用户
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --add-config 'SCRAM-SHA-256=[password=secret]' \
  --entity-type users --entity-name alice

bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --add-config 'SCRAM-SHA-512=[password=secret]' \
  --entity-type users --entity-name bob

# 验证用户
bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --describe --entity-type users --entity-name alice
```

```properties
# ==================== SASL SCRAM 配置 ====================

sasl.enabled.mechanisms=SCRAM-SHA-256,SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-256

# JAAS 配置
KafkaServer {
   org.apache.kafka.common.security.scram.ScramLoginModule required
   username="controller"
   password="controller-secret";
};
```

### 3.3 SASL GSSAPI (Kerberos) 认证

```properties
# ==================== SASL GSSAPI 配置 ====================

sasl.enabled.mechanisms=GSSAPI
sasl.mechanism.inter.broker.protocol=GSSAPI
sasl.kerberos.service.name=kafka

# JAAS 配置
KafkaServer {
   com.sun.security.auth.module.Krb5LoginModule required
   useKeyTab=true
   storeKey=true
   keyTab="/etc/security/keytabs/kafka.controller.keytab"
   principal="kafka/controller.example.com@EXAMPLE.COM";
};

# krb5.conf
[libdefaults]
  default_realm = EXAMPLE.COM
  dns_lookup_realm = false
  dns_lookup_kdc = false
  ticket_lifetime = 24h
  renew_lifetime = 7d
  forwardable = true

[realms]
  EXAMPLE.COM = {
    kdc = kdc.example.com
    admin_server = kdc.example.com
  }
```

---

## 4. ACL 授权

### 4.1 ACL 概述

```scala
/**
 * Kafka ACL 权限模型:
 *
 * 资源类型:
 * - Topic: Topic 相关操作
 * - Group: Consumer Group 相关操作
 * - Cluster: 集群级别操作
 * - TransactionalId: 事务 ID 操作
 *
 * 操作类型:
 * - Read: 读取操作
 * - Write: 写入操作
 * - Create: 创建资源
 * - Delete: 删除资源
 * - Alter: 修改资源
 * - Describe: 查询资源
 * - ClusterAction: 集群操作
 * - All: 所有操作
 *
 * 权限类型:
 * - Allow: 允许
 * - Deny: 拒绝 (优先级高于 Allow)
 */
```

### 4.2 管理 ACL

```bash
# ==================== 创建 ACL ====================

# 允许用户 alice 读取 test-topic
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --add --allow-principal User:alice \
  --operation Read --topic test-topic

# 允许用户 bob 写入 test-topic
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --add --allow-principal User:bob \
  --operation Write --topic test-topic

# 允许用户 admin 对所有 Topic 的所有操作
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --add --allow-principal User:admin \
  --operation All --topic '*'

# 允许用户 controller 集群级别操作
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --add --allow-principal User:controller \
  --operation ClusterAction --cluster

# ==================== 查看 ACL ====================

# 查看 Topic ACL
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --list --topic test-topic

# 查看所有 ACL
bin/kafka-acls.sh --bootstrap-server localhost:9092 --list

# 查看用户 ACL
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --list --principal User:alice

# ==================== 删除 ACL ====================

# 删除特定 ACL
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --remove --allow-principal User:alice \
  --operation Read --topic test-topic

# 删除用户所有 ACL
bin/kafka-acls.sh --bootstrap-server localhost:9092 \
  --remove --allow-principal User:alice \
  --operation All --topic '*'
```

### 4.3 Super User 配置

```properties
# ==================== Super User 配置 ====================

# 超级用户 (跳过 ACL 检查)
super.users=User:admin;User:controller

# 或者使用通配符
super.users=User:*
```

---

## 5. Controller 安全配置

### 5.1 Controller 间通信安全

```properties
# ==================== Controller 通信安全 ====================

# Controller 监听器
controller.listener.names=CONTROLLER

# Controller 间通信协议
controller.quorum.protocol=SASL_SSL

# Controller 认证机制
controller.quorum.sasl.enabled.mechanisms=SCRAM-SHA-256
controller.quorum.sasl.mechanism=SCRAM-SHA-256

# Controller SSL 配置
listeners=CONTROLLER://:9093
controller.listener.names=CONTROLLER
inter.controller.listener.name=CONTROLLER

# Controller SSL
ssl.keystore.location=/path/to/controller.keystore.p12
ssl.keystore.password=controllerpass
ssl.truststore.location=/path/to/controller.truststore.jks
ssl.truststore.password=truststorepass

# Controller SASL
# JAAS 配置文件需要包含 Controller 凭证
KafkaServer {
   org.apache.kafka.common.security.scram.ScramLoginModule required
   username="controller"
   password="controller-secret";
};
```

### 5.2 元数据日志安全

```properties
# ==================== 元数据日志安全 ====================

# 元数据日志目录权限
# 确保只有 kafka 用户可以访问
# chmod 700 /tmp/kraft-combined-logs/metadata
# chown kafka:kafka /tmp/kraft-combined-logs/metadata

# 日志加密 (如果需要)
# 使用文件系统加密 (如 LUKS)
# 或使用磁盘加密
```

---

## 6. 客户端安全配置

### 6.1 Producer 安全配置

```properties
# ==================== Producer 安全配置 ====================

# 安全协议
security.protocol=SASL_SSL

# SASL 机制
sasl.mechanism=SCRAM-SHA-256

# JAAS 配置
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="alice" password="alice-secret";

# SSL 配置
ssl.truststore.location=/path/to/client.truststore.jks
ssl.truststore.password=truststorepass

# 端点识别
ssl.endpoint.identification.algorithm=https
```

### 6.2 Consumer 安全配置

```properties
# ==================== Consumer 安全配置 ====================

# 安全协议
security.protocol=SASL_SSL

# SASL 机制
sasl.mechanism=SCRAM-SHA-256

# JAAS 配置
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="bob" password="bob-secret";

# SSL 配置
ssl.truststore.location=/path/to/client.truststore.jks
ssl.truststore.password=truststorepass

# Group ID
group.id=secure-consumer-group
```

---

## 7. 审计日志

### 7.1 配置审计日志

```properties
# ==================== 审计日志配置 ====================

# 启用审计日志
authorizer.class.name=kafka.security.authorizer.AclAuthorizer

# 审计日志配置
# 在 log4j.properties 中添加
log4j.appender.auditLog=org.apache.log4j.DailyRollingFileAppender
log4j.appender.auditLog.DatePattern='.'yyyy-MM-dd
log4j.appender.auditLog.File=/var/log/kafka/audit.log
log4j.appender.auditLog.layout=org.apache.log4j.PatternLayout
log4j.appender.auditLog.layout.ConversionPattern=[%d] %p %m (%c)%n

# 审计日志级别
log4j.logger.kafka.authorizer.logger=INFO, auditLog
log4j.additivity.kafka.authorizer.logger=false
```

### 7.2 审计日志分析

```bash
# 查看审计日志
tail -f /var/log/kafka/audit.log

# 统计失败的操作
grep "denied" /var/log/kafka/audit.log | wc -l

# 查看特定用户的操作
grep "User:alice" /var/log/kafka/audit.log

# 查看特定 Topic 的操作
grep "Resource:Topic:test-topic" /var/log/kafka/audit.log
```

---

## 8. 安全最佳实践

### 8.1 证书管理

```bash
# ==================== 证书轮换 ====================

# 1. 生成新证书
openssl genpkey -algorithm RSA -out server-key-new.pem -pkeyopt rsa_keygen_bits:2048
openssl req -new -key server-key-new.pem -out server-csr-new.pem
openssl x509 -req -in server-csr-new.pem -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert-new.pem -days 365

# 2. 更新 Keystore
openssl pkcs12 -export -in server-cert-new.pem -inkey server-key-new.pem \
  -out server.keystore.p12 -name kafka-server \
  -CAfile ca-cert.pem -caname root

# 3. 重启 Kafka
bin/kafka-server-stop.sh
bin/kafka-server-start.sh -daemon config/kraft/server.properties

# 4. 验证新证书
openssl s_client -connect localhost:9092 -showcerts
```

### 8.2 密码管理

```bash
# ==================== 密码存储 ====================

# 使用环境变量存储密码
export KAFKA_SERVER_KEY_PASSWORD="serverpass"
export KAFKA_SERVER_TRUSTSTORE_PASSWORD="truststorepass"

# 或使用密码文件
echo "serverpass" > /etc/kafka/secrets/keystore.password
chmod 400 /etc/kafka/secrets/keystore.password

# 在配置文件中引用
# ssl.keystore.password=${file:/etc/kafka/secrets/keystore.password}
```

### 8.3 网络隔离

```bash
# ==================== 防火墙配置 ====================

# 只允许特定网络访问
# iptables
iptables -A INPUT -p tcp --dport 9092 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 9093 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 9092 -j DROP
iptables -A INPUT -p tcp --dport 9093 -j DROP

# firewalld
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="9092" protocol="tcp" accept'
firewall-cmd --reload
```

---

## 9. 安全验证

### 9.1 验证 SSL 连接

```bash
# 测试 SSL 连接
openssl s_client -connect localhost:9092 -cert client-cert.pem -key client-key.pem -CAfile ca-cert.pem

# 验证证书
openssl x509 -in server-cert.pem -text -noout

# 验证 Keystore
keytool -list -v -keystore server.keystore.p12 -storetype PKCS12
```

### 9.2 验证 SASL 认证

```bash
# 测试 SASL 认证
kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic test-topic \
  --producer.config client-sasl.config

# client-sasl.config:
# security.protocol=SASL_SSL
# sasl.mechanism=SCRAM-SHA-256
# sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="alice" password="alice-secret";
```

### 9.3 验证 ACL

```bash
# 测试 ACL 权限
# 使用无权限用户尝试写入
kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic test-topic \
  --producer.config client.config

# 应该看到权限错误
# ERROR Error when sending message to topic test-topic with key: ...
# org.apache.kafka.common.errors.TopicAuthorizationException: Not authorized to access topic
```

---

## 10. 相关文档

- **[15-best-practices.md](./15-best-practices.md)** - 最佳实践
- **[17-backup-recovery.md](./17-backup-recovery.md)** - 备份与恢复
- **[11-troubleshooting.md](./11-troubleshooting.md)** - 故障排查指南

---

**返回**: [README.md](./README.md)
