# 07. 安全协议详解

Kafka 提供完善的安全体系，包括加密传输和多种认证机制。本文深入分析 SSL/TLS 加密、SASL 认证以及安全协议的配置实战。

## 目录
- [1. 安全协议概述](#1-安全协议概述)
- [2. SSL/TLS 加密](#2-ssltls-加密)
- [3. SASL 认证](#3-sasl-认证)
- [4. 安全协议组合](#4-安全协议组合)
- [5. 配置实战](#5-配置实战)

---

## 1. 安全协议概述

### 1.1 安全需求

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Kafka 安全需求                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. 加密 (Encryption)                  2. 认证 (Authentication)     │
│     ┌──────────────────────┐              ┌──────────────────────┐  │
│     │ • 防止窃听            │              │ • 验证客户端身份      │  │
│     │ • 防止中间人攻击      │              │ • 防止未授权访问      │  │
│     │ • 数据完整性保护      │              │ • 审计追踪           │  │
│     └──────────────────────┘              └──────────────────────┘  │
│                                                                     │
│  3. 授权 (Authorization)               4. 审计 (Audit)              │
│     ┌──────────────────────┐              ┌──────────────────────┐  │
│     │ • ACL 访问控制        │              │ • 操作日志记录        │  │
│     │ • 资源权限管理        │              │ • 安全事件告警        │  │
│     │ • 最小权限原则        │              │ • 合规性检查         │  │
│     └──────────────────────┘              └──────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Kafka 安全体系

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Kafka 安全架构                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐  │
│   │                      应用层                                 │  │
│   │  • 生产/消费消息                                            │  │
│   │  • 管理操作 (创建 Topic, 配置修改)                           │  │
│   └───────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│   ┌───────────────────────▼─────────────────────────────────────┐  │
│   │                     ACL 层                                  │  │
│   │  • 检查操作权限 (Principal + Resource + Operation)          │  │
│   └───────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│   ┌───────────────────────▼─────────────────────────────────────┐  │
│   │                    SASL 层                                  │  │
│   │  • GSSAPI (Kerberos)                                        │  │
│   │  • PLAIN / SCRAM-SHA-256 / SCRAM-SHA-512                    │  │
│   │  • OAUTHBEARER                                              │  │
│   └───────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│   ┌───────────────────────▼─────────────────────────────────────┐  │
│   │                    SSL/TLS 层                               │  │
│   │  • 证书验证                                                 │  │
│   │  • 加密通信                                                 │  │
│   └───────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│   ┌───────────────────────▼─────────────────────────────────────┐  │
│   │                    TCP 层                                   │  │
│   └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 安全协议类型

**源码位置**: `clients/src/main/java/org/apache/kafka/common/security/auth/SecurityProtocol.java`

```java
public enum SecurityProtocol {
    // 明文传输，无认证无加密（默认，仅用于开发/测试）
    PLAINTEXT(0, false, false),

    // SSL 加密，支持证书认证
    SSL(1, true, false),

    // SASL 认证，无加密
    SASL_PLAINTEXT(2, false, true),

    // SASL 认证 + SSL 加密（生产环境推荐）
    SASL_SSL(3, true, true);

    private final int id;
    private final boolean isSecurityEnabled;
    private final boolean isSaslEnabled;

    SecurityProtocol(int id, boolean isSecurityEnabled, boolean isSaslEnabled) {
        this.id = id;
        this.isSecurityEnabled = isSecurityEnabled;
        this.isSaslEnabled = isSaslEnabled;
    }

    public boolean isSecurityEnabled() {
        return isSecurityEnabled;
    }

    public boolean isSaslEnabled() {
        return isSaslEnabled;
    }
}
```

| 协议 | 加密 | 认证 | 适用场景 |
|------|------|------|---------|
| **PLAINTEXT** | ✗ | ✗ | 开发/测试环境 |
| **SSL** | ✓ | 证书 | 对外服务，证书管理方便 |
| **SASL_PLAINTEXT** | ✗ | SASL | 内网环境，信任网络 |
| **SASL_SSL** | ✓ | SASL | 生产环境，最高安全性 |

---

## 2. SSL/TLS 加密

### 2.1 SSL 握手流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SSL/TLS 握手流程                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Client                           Server                           │
│     │                                 │                             │
│     │ ───── ClientHello ─────────────→│  支持的加密套件、随机数      │
│     │                                 │                             │
│     │ ←──── ServerHello ─────────────│  选择的加密套件、随机数      │
│     │ ←──── Certificate ─────────────│  服务器证书                  │
│     │ ←──── [ServerKeyExchange] ─────│  密钥交换参数（如需要）      │
│     │ ←──── [CertificateRequest] ────│  请求客户端证书（双向认证）  │
│     │ ←──── ServerHelloDone ─────────│                             │
│     │                                 │                             │
│     │ ───── [Certificate] ──────────→│  客户端证书（双向认证）      │
│     │ ───── ClientKeyExchange ──────→│  预主密钥加密传输            │
│     │ ───── [CertificateVerify] ────→│  证书签名验证                │
│     │ ───── ChangeCipherSpec ───────→│  切换到加密模式              │
│     │ ───── Finished ───────────────→│  握手完整性验证              │
│     │                                 │                             │
│     │ ←──── ChangeCipherSpec ────────│  切换到加密模式              │
│     │ ←──── Finished ────────────────│  握手完整性验证              │
│     │                                 │                             │
│     ══════════════════════════════════  加密通道建立完成            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 证书配置

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SSL 证书结构                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   根 CA (Root CA)                                                   │
│        │                                                            │
│        ├── 中间 CA (Intermediate CA)                                │
│        │       │                                                     │
│        │       ├── Kafka Broker 证书                                │
│        │       │    server.keystore.jks                              │
│        │       │    • 服务器私钥                                     │
│        │       │    • 服务器证书链                                   │
│        │       │                                                     │
│        │       └── 其他服务证书...                                   │
│        │                                                            │
│        └── 客户端信任库                                              │
│             client.truststore.jks                                    │
│             • 根 CA 证书                                             │
│             • 中间 CA 证书                                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**密钥库配置**:

```java
// SSL 配置类
public class SslConfigs {
    // 密钥库（KeyStore）- 服务器用于证明自己的身份
    public static final String SSL_KEYSTORE_LOCATION_CONFIG = "ssl.keystore.location";
    public static final String SSL_KEYSTORE_PASSWORD_CONFIG = "ssl.keystore.password";
    public static final String SSL_KEY_PASSWORD_CONFIG = "ssl.key.password";
    public static final String SSL_KEYSTORE_TYPE_CONFIG = "ssl.keystore.type";  // 默认: JKS

    // 信任库（TrustStore）- 客户端用于验证服务器
    public static final String SSL_TRUSTSTORE_LOCATION_CONFIG = "ssl.truststore.location";
    public static final String SSL_TRUSTSTORE_PASSWORD_CONFIG = "ssl.truststore.password";
    public static final String SSL_TRUSTSTORE_TYPE_CONFIG = "ssl.truststore.type";  // 默认: JKS

    // 其他 SSL 配置
    public static final String SSL_PROTOCOL_CONFIG = "ssl.protocol";  // 默认: TLSv1.2
    public static final String SSL_ENABLED_PROTOCOLS_CONFIG = "ssl.enabled.protocols";
    public static final String SSL_CIPHER_SUITES_CONFIG = "ssl.cipher.suites";

    // 主机名验证
    public static final String SSL_ENDPOINT_IDENTIFICATION_ALGORITHM_CONFIG =
        "ssl.endpoint.identification.algorithm";  // 默认: https
}
```

### 2.3 双向认证

```
┌─────────────────────────────────────────────────────────────────────┐
│                    单向认证 vs 双向认证                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   单向认证（默认）                                                   │
│   ┌─────────────┐               ┌─────────────┐                    │
│   │   Client    │ ─── 验证证书 ──→│   Server    │                    │
│   │             │               │  需要证书   │                    │
│   │  TrustStore │               │  KeyStore   │                    │
│   └─────────────┘               └─────────────┘                    │
│                                                                     │
│   双向认证（Mutual TLS）                                             │
│   ┌─────────────┐               ┌─────────────┐                    │
│   │   Client    │ ←── 验证证书 ───│   Server    │                    │
│   │  KeyStore   │               │  KeyStore   │                    │
│   │  TrustStore │ ─── 验证证书 ──→│  TrustStore │                    │
│   └─────────────┘               └─────────────┘                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Broker 配置（双向认证）**:
```properties
# 启用客户端证书验证
ssl.client.auth=required

# 信任库配置（用于验证客户端）
ssl.truststore.location=/path/to/kafka.server.truststore.jks
ssl.truststore.password=truststore-password
```

### 2.4 性能影响

| 指标 | PLAINTEXT | SSL/TLS | 影响 |
|------|-----------|---------|------|
| CPU 使用率 | 基准 | +10-30% | 加密/解密开销 |
| 延迟 | 基准 | +1-5ms | 握手和加密开销 |
| 吞吐量 | 基准 | -10-20% | 视硬件加速能力 |

**优化建议**:
1. 使用硬件 SSL 加速（AES-NI 指令集）
2. 启用 SSL 会话复用（Session Resumption）
3. 合理设置 TLS 版本（推荐 TLSv1.2+）
4. 选择高效的加密套件

---

## 3. SASL 认证

### 3.1 SASL 机制

**源码位置**: `clients/src/main/java/org/apache/kafka/common/security/auth/SaslConfigs.java`

```java
public class SaslConfigs {
    // SASL 机制配置
    public static final String SASL_MECHANISM = "sasl.mechanism";
    public static final String DEFAULT_SASL_MECHANISM = "GSSAPI";

    // 支持的 SASL 机制
    public static final List<String> DEFAULT_SASL_MECHANISMS =
        Arrays.asList("GSSAPI", "PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER");

    // JAAS 配置
    public static final String SASL_JAAS_CONFIG = "sasl.jaas.config";

    // Kerberos 特定配置
    public static final String SASL_KERBEROS_SERVICE_NAME = "sasl.kerberos.service.name";
    public static final String SASL_KERBEROS_KINIT_CMD = "sasl.kerberos.kinit.cmd";
    public static final String SASL_KERBEROS_TICKET_RENEW_WINDOW_FACTOR =
        "sasl.kerberos.ticket.renew.window.factor";
    public static final String SASL_KERBEROS_TICKET_RENEW_JITTER =
        "sasl.kerberos.ticket.renew.jitter";
    public static final String SASL_KERBEROS_MIN_TIME_BEFORE_RELOGIN =
        "sasl.kerberos.min.time.before.relogin";

    // SCRAM 配置
    public static final String SASL_SCRAM_USERNAME = "sasl.scram.username";
    public static final String SASL_SCRAM_PASSWORD = "sasl.scram.password";

    // OAUTHBEARER 配置
    public static final String SASL_OAUTHBEARER_TOKEN_ENDPOINT_URL =
        "sasl.oauthbearer.token.endpoint.url";
    public static final String SASL_OAUTHBEARER_CLIENT_ID = "sasl.oauthbearer.client.id";
    public static final String SASL_OAUTHBEARER_CLIENT_SECRET = "sasl.oauthbearer.client.secret";
}
```

### 3.2 GSSAPI (Kerberos)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Kerberos 认证流程                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Client          KDC (Key Distribution Center)       Kafka         │
│     │                     │                            │           │
│     │ 1. AS-REQ ─────────→│                           │           │
│     │ (请求 TGT)          │                           │           │
│     │                     │                           │           │
│     │←──────── 2. AS-REP │                           │           │
│     │ (返回 TGT)          │                           │           │
│     │                     │                           │           │
│     │ 3. TGS-REQ ────────→│                           │           │
│     │ (请求 Service票)    │                           │           │
│     │                     │                           │           │
│     │←──────── 4. TGS-REP │                           │           │
│     │ (返回 Service票)    │                           │           │
│     │                     │                           │           │
│     │────────────────────────────────── 5. SASL/GSSAPI ──→│       │
│     │                     │                            │           │
│     │←───────────────────────────────── 6. 认证成功 ─────│       │
│     │                     │                            │           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**配置示例**:
```properties
# Kafka Client 配置
sasl.mechanism=GSSAPI
sasl.kerberos.service.name=kafka
sasl.jaas.config=com.sun.security.auth.module.Krb5LoginModule required \
    useKeyTab=true \
    storeKey=true \
    keyTab="/path/to/user.keytab" \
    principal="user@EXAMPLE.COM";

# 或者使用 ticket cache
sasl.jaas.config=com.sun.security.auth.module.Krb5LoginModule required \
    useTicketCache=true \
    renewTicket=true \
    principal="user@EXAMPLE.COM";
```

### 3.3 PLAIN

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PLAIN 认证流程                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Client                                    Server                  │
│     │                                         │                     │
│     │ ───── username + password ─────────────→│                     │
│     │   明文传输（依赖 SSL 加密）              │                     │
│     │                                         │                     │
│     │                                         │ 验证凭据             │
│     │                                         │ (LDAP/DB/File)      │
│     │                                         │                     │
│     │ ←──── 认证结果 ─────────────────────────│                     │
│     │                                         │                     │
│                                                                     │
│   ⚠️ 警告：PLAIN 必须与 SSL 配合使用，否则密码会被窃听              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**配置示例**:
```properties
# 客户端配置
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
    username="alice" \
    password="alice-secret";

# Broker 配置（使用静态用户配置）
listener.name.sasl_ssl.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
    user_alice="alice-secret" \
    user_bob="bob-secret";
```

### 3.4 SCRAM-SHA-256/512

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SCRAM 认证流程                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Client                                    Server                  │
│     │                                         │                     │
│     │ ───── client-first-message ────────────→│                     │
│     │   (username, nonce)                     │                     │
│     │                                         │                     │
│     │ ←──── server-first-message ─────────────│                     │
│     │   (salt, iteration count, server nonce) │                     │
│     │                                         │                     │
│     │ ───── client-final-message ────────────→│                     │
│     │   (client proof)                        │                     │
│     │                                         │                     │
│     │                                         │ 验证 client proof   │
│     │                                         │                     │
│     │ ←──── server-final-message ─────────────│                     │
│     │   (server signature)                    │                     │
│     │                                         │                     │
│                                                                     │
│   特点：                                                             │
│   • 密码永不以明文传输                                               │
│   • 服务器不需要存储明文密码，只存储 salt 和 iteration count         │
│   • 防止重放攻击                                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**动态用户管理**:
```bash
# 创建 SCRAM 用户
kafka-configs.sh --bootstrap-server localhost:9092 \
    --alter --add-config \
    'SCRAM-SHA-256=[iterations=8192,password=alice-secret]' \
    --entity-type users --entity-name alice

# 删除用户
kafka-configs.sh --bootstrap-server localhost:9092 \
    --alter --delete-config 'SCRAM-SHA-256' \
    --entity-type users --entity-name alice
```

### 3.5 OAUTHBEARER

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OAuth 2.0 认证流程                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Client           Token Endpoint          Kafka                    │
│     │                    │                  │                       │
│     │ 1. 获取 Token ─────→│                 │                       │
│     │   (client_id,      │                 │                       │
│     │    client_secret)  │                 │                       │
│     │                    │                 │                       │
│     │←──── 2. JWT Token ─│                 │                       │
│     │                    │                 │                       │
│     │────────────────────────────────── 3. SASL/OAUTHBEARER ──→│  │
│     │                    │                 │                       │
│     │                    │                 │ 4. 验证 JWT           │
│     │                    │                 │    (本地或调用 IdP)   │
│     │                    │                 │                       │
│     │←────────────────────────────────── 5. 认证结果 ──────────│  │
│     │                    │                 │                       │
│                                                                     │
│   特点：支持 Token 刷新，适合云原生环境                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**配置示例**:
```properties
# 客户端配置
sasl.mechanism=OAUTHBEARER
sasl.oauthbearer.token.endpoint.url=https://auth.example.com/oauth2/token
sasl.oauthbearer.client.id=kafka-client
sasl.oauthbearer.client.secret=client-secret

# 或者使用自定义 Token 提供器
sasl.login.callback.handler.class=com.example.CustomOAuthBearerLoginCallbackHandler
```

---

## 4. 安全协议组合

### 4.1 PLAINTEXT

```properties
# Broker 配置
listeners=PLAINTEXT://:9092
security.inter.broker.protocol=PLAINTEXT

# 生产环境 ⚠️ 禁止使用
```

### 4.2 SSL

```properties
# Broker 配置
listeners=SSL://:9093

# SSL 配置
ssl.keystore.location=/path/to/kafka.server.keystore.jks
ssl.keystore.password=keystore-password
ssl.key.password=key-password
ssl.truststore.location=/path/to/kafka.server.truststore.jks
ssl.truststore.password=truststore-password

# 可选：启用双向认证
ssl.client.auth=required

# 客户端配置
security.protocol=SSL
ssl.truststore.location=/path/to/kafka.client.truststore.jks
ssl.truststore.password=truststore-password
ssl.endpoint.identification.algorithm=https
```

### 4.3 SASL_PLAINTEXT

```properties
# Broker 配置
listeners=SASL_PLAINTEXT://:9092
sasl.enabled.mechanisms=SCRAM-SHA-256

# 监听器特定配置
listener.name.sasl_plaintext.scram-sha-256.sasl.jaas.config=...

# 客户端配置
security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-256
sasl.jaas.config=...
```

### 4.4 SASL_SSL

```properties
# Broker 配置（推荐生产环境配置）
listeners=SASL_SSL://:9093

# SSL 配置
ssl.keystore.location=/path/to/kafka.server.keystore.jks
ssl.keystore.password=keystore-password
ssl.truststore.location=/path/to/kafka.server.truststore.jks
ssl.truststore.password=truststore-password

# SASL 配置
sasl.enabled.mechanisms=SCRAM-SHA-256,SCRAM-SHA-512

# 客户端配置
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-256
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="alice" \
    password="alice-secret";

# SSL 信任库配置
ssl.truststore.location=/path/to/kafka.client.truststore.jks
ssl.truststore.password=truststore-password
ssl.endpoint.identification.algorithm=https
```

---

## 5. 配置实战

### 5.1 SSL 配置

**生成证书脚本**:
```bash
#!/bin/bash

# 配置
KEYSTORE_FILENAME="kafka.keystore.jks"
TRUSTSTORE_FILENAME="kafka.truststore.jks"
VALIDITY=365
KEYSTORE_PASSWORD="kafka123"
TRUSTSTORE_PASSWORD="kafka123"
KEY_PASSWORD="kafka123"
CLUSTER_NAME="kafka-cluster"

# 生成 CA 密钥对
openssl req -new -x509 -keyout ca-key -out ca-cert -days $VALIDITY \
    -subj "/CN=Kafka-CA/OU=Kafka/O=Example/L=Beijing/C=CN"

# 导入 CA 证书到 TrustStore
keytool -keystore $TRUSTSTORE_FILENAME -alias CARoot -import -file ca-cert \
    -storepass $TRUSTSTORE_PASSWORD -noprompt

# 为每个 Broker 生成密钥对
for i in 1 2 3; do
    BROKER_NAME="kafka-broker-$i"
    BROKER_KEYSTORE="${BROKER_NAME}.keystore.jks"

    # 生成密钥对
    keytool -keystore $BROKER_KEYSTORE -alias $BROKER_NAME -validity $VALIDITY \
        -genkey -keyalg RSA -storepass $KEYSTORE_PASSWORD \
        -keypass $KEY_PASSWORD \
        -dname "CN=${BROKER_NAME},OU=Kafka,O=Example,L=Beijing,C=CN" \
        -ext "SAN=dns:${BROKER_NAME},dns:localhost,ip:127.0.0.1"

    # 生成证书签名请求
    keytool -keystore $BROKER_KEYSTORE -alias $BROKER_NAME -certreq \
        -file ${BROKER_NAME}.csr -storepass $KEYSTORE_PASSWORD

    # CA 签名
    openssl x509 -req -CA ca-cert -CAkey ca-key -in ${BROKER_NAME}.csr \
        -out ${BROKER_NAME}.cer -days $VALIDITY -CAcreateserial

    # 导入 CA 证书和签名证书
    keytool -keystore $BROKER_KEYSTORE -alias CARoot -import -file ca-cert \
        -storepass $KEYSTORE_PASSWORD -noprompt
    keytool -keystore $BROKER_KEYSTORE -alias $BROKER_NAME -import \
        -file ${BROKER_NAME}.cer -storepass $KEYSTORE_PASSWORD -noprompt

    # 清理临时文件
    rm ${BROKER_NAME}.csr ${BROKER_NAME}.cer
done

echo "证书生成完成！"
```

### 5.2 SASL 配置

**SCRAM 用户管理脚本**:
```bash
#!/bin/bash

BOOTSTRAP_SERVER="localhost:9092"

# 创建管理员用户
kafka-configs.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --alter --add-config 'SCRAM-SHA-256=[password=admin-secret]' \
    --entity-type users --entity-name admin

# 创建应用用户
kafka-configs.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --alter --add-config 'SCRAM-SHA-256=[password=app-secret]' \
    --entity-type users --entity-name app-user

# 创建消费者用户
kafka-configs.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --alter --add-config 'SCRAM-SHA-256=[password=consumer-secret]' \
    --entity-type users --entity-name consumer-user

# 列出所有用户
kafka-configs.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --describe --entity-type users

# 删除用户
# kafka-configs.sh --bootstrap-server $BOOTSTRAP_SERVER \
#     --alter --delete-config 'SCRAM-SHA-256' \
#     --entity-type users --entity-name consumer-user
```

### 5.3 ACL 配置

```bash
#!/bin/bash

BOOTSTRAP_SERVER="localhost:9093"
COMMAND_CONFIG="admin.properties"  # 包含 SASL_SSL 配置

# 创建 Topic
kafka-topics.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --command-config $COMMAND_CONFIG \
    --create --topic orders --partitions 6 --replication-factor 3

# 授权 app-user 生产消息到 orders topic
kafka-acls.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --command-config $COMMAND_CONFIG \
    --add --allow-principal User:app-user \
    --operation Write --topic orders

# 授权 consumer-user 消费消息
kafka-acls.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --command-config $COMMAND_CONFIG \
    --add --allow-principal User:consumer-user \
    --operation Read --topic orders

# 授权消费者组访问
kafka-acls.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --command-config $COMMAND_CONFIG \
    --add --allow-principal User:consumer-user \
    --operation Read --group order-consumers

# 查看 ACL
kafka-acls.sh --bootstrap-server $BOOTSTRAP_SERVER \
    --command-config $COMMAND_CONFIG \
    --list

# 删除 ACL
# kafka-acls.sh --bootstrap-server $BOOTSTRAP_SERVER \
#     --command-config $COMMAND_CONFIG \
#     --remove --allow-principal User:consumer-user \
#     --operation Read --topic orders
```

### 5.4 安全最佳实践

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Kafka 安全最佳实践                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. 传输安全                                                         │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │ • 生产环境必须使用 SASL_SSL                               │  │
│     │ • 禁用 PLAINTEXT 和 SASL_PLAINTEXT                        │  │
│     │ • 启用主机名验证 (ssl.endpoint.identification.algorithm)  │  │
│     │ • 定期更新证书（建议 1 年有效期）                         │  │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                     │
│  2. 认证机制                                                         │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │ • 优先使用 SCRAM-SHA-512 或 OAuth2                      │  │
│     │ • Kerberos 适合已有 AD/LDAP 的企业                      │  │
│     │ • 禁用 PLAIN（除非配合严格网络隔离）                    │  │
│     │ • 定期轮换凭据                                          │  │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                     │
│  3. 访问控制                                                         │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │ • 启用 ACL，默认拒绝所有访问                              │  │
│     │ • 最小权限原则：每个用户只授予必要的权限                  │  │
│     │ • 使用不同的用户分别用于生产、消费、管理                  │  │
│     │ • 定期审计 ACL 配置                                       │  │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                     │
│  4. 网络安全                                                         │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │ • 使用防火墙限制 Broker 端口访问                          │  │
│     │ • 将 Kafka 部署在私有子网                                 │  │
│     │ • 使用 VPN 或专线连接跨数据中心                           │  │
│     │ • 启用 TLS 1.2+，禁用弱加密算法                           │  │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                     │
│  5. 监控与审计                                                       │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │ • 启用 Kafka 授权日志                                     │  │
│     │ • 监控认证失败事件                                        │  │
│     │ • 设置异常访问告警                                        │  │
│     │ • 定期分析访问模式                                        │  │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**安全配置检查清单**:

```yaml
检查项:
  传输层:
    - [ ] 禁用了 PLAINTEXT 监听器
    - [ ] 启用了 SSL/SASL_SSL
    - [ ] 证书未过期
    - [ ] 启用了主机名验证

  认证:
    - [ ] 使用强认证机制 (SCRAM/OAuth)
    - [ ] 密码策略符合要求
    - [ ] 服务账户权限最小化

  授权:
    - [ ] 启用了 ACL
    - [ ] 默认拒绝策略
    - [ ] 定期审计 ACL

  网络:
    - [ ] 防火墙配置正确
    - [ ] 不暴露在公网
    - [ ] 跨数据中心加密

  监控:
    - [ ] 授权日志启用
    - [ ] 安全事件告警
    - [ ] 异常访问检测
```

---

## 总结

| 安全需求 | 推荐配置 | 说明 |
|---------|---------|------|
| 最小安全配置 | SASL_SSL + SCRAM-SHA-512 + ACL | 适合大多数生产环境 |
| 企业集成 | SASL_SSL + Kerberos + ACL | 与 AD/LDAP 集成 |
| 云原生 | SASL_SSL + OAuth2 + ACL | 适合 Kubernetes 环境 |
| 高安全要求 | mTLS + 双向认证 + ACL | 最高安全级别 |

---

**上一篇**: [06. NetworkClient 网络客户端实现](./06-network-client.md)

**本章完结** 🎉

**返回**: [11. Kafka 网络协议详解](./README.md)
