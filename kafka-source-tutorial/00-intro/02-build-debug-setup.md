# Kafka 构建与调试环境搭建

## 目录
- [1. 环境要求](#1-环境要求)
- [2. 获取源码](#2-获取源码)
- [3. 构建项目](#3-构建项目)
- [4. IDE 配置](#4-ide-配置)
- [5. 调试配置](#5-调试配置)
- [6. 常见问题](#6-常见问题)

---

## 1. 环境要求

### 1.1 基础环境

| 组件 | 最低版本 | 推荐版本 | 说明 |
|-----|---------|---------|------|
| JDK | 17 | 17 或 21 | 必须是 JDK 17+ |
| Gradle | - | 8.5+ | 使用项目自带的 gradlew |
| Scala | 2.13 | 2.13.12 | 服务端使用 Scala |
| Python | 3.6+ | 3.8+ | 部分脚本需要 |
| 内存 | 4GB | 8GB+ | 构建需要较多内存 |
| 磁盘 | 10GB | 20GB+ | 源码和构建产物 |

### 1.2 检查环境

```bash
# 检查 Java 版本
java -version
# 输出示例: openjdk version "17.0.x"

# 检查 Scala 版本 (可选)
scala -version

# 检查环境变量
echo $JAVA_HOME
echo $PATH
```

### 1.3 安装 JDK 17

**Ubuntu/Debian:**
```bash
# 安装 OpenJDK 17
sudo apt update
sudo apt install openjdk-17-jdk

# 设置 JAVA_HOME
echo 'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64' >> ~/.bashrc
source ~/.bashrc
```

**macOS:**
```bash
# 使用 Homebrew
brew install openjdk@17

# 设置 JAVA_HOME
echo 'export JAVA_HOME=$(/usr/libexec/java_home -v 17)' >> ~/.zshrc
source ~/.zshrc
```

**Windows:**
1. 下载并安装 [Adoptium JDK 17](https://adoptium.net/)
2. 设置环境变量 `JAVA_HOME`
3. 添加 `%JAVA_HOME%\bin` 到 PATH

---

## 2. 获取源码

### 2.1 克隆仓库

```bash
# 克隆 Apache Kafka 官方仓库
git clone https://github.com/apache/kafka.git
cd kafka

# 或者指定深度克隆 (加快速度)
git clone --depth 1 https://github.com/apache/kafka.git
cd kafka
```

### 2.2 检查分支

```bash
# 查看当前分支
git branch

# 查看所有分支
git branch -a

# 切换到特定版本 (例如 3.7.x)
git checkout 3.7

# 切换到 trunk (最新开发版)
git checkout trunk
```

### 2.3 仓库结构概览

```bash
# 查看目录结构
ls -la

# 查看构建文件
cat gradle.properties
cat settings.gradle
```

---

## 3. 构建项目

### 3.1 快速构建

```bash
# 完整构建 (包括测试)
./gradlew build

# 跳过测试构建
./gradlew build -x test

# 仅编译
./gradlew compileScala compileJava

# 构建特定模块
./gradlew :core:build
./gradlew :clients:build
```

### 3.2 构建分发包

```bash
# 构建 tar.gz 分发包
./gradlew clean releaseTarGz

# 构建产物位置
ls -l core/build/distributions/
```

### 3.3 常用 Gradle 任务

```bash
# 查看所有可用任务
./gradlew tasks

# 清理构建产物
./gradlew clean

# 生成 IDE 项目文件
./gradlew idea    # IntelliJ IDEA
./gradlew eclipse # Eclipse

# 查看依赖树
./gradlew :core:dependencies

# 运行特定测试
./gradlew :core:test --tests kafka.server.KafkaServerTest

# 运行所有测试
./gradlew test

# 生成测试报告
./gradlew test report
```

### 3.4 构建优化

**增加 Gradle 内存:**

编辑 `~/.gradle/gradle.properties`:
```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
org.gradle.parallel=true
org.gradle.caching=true
```

**使用 Gradle Daemon (默认启用):**
```bash
# 检查 Daemon 状态
./gradlew --status

# 停止所有 Daemon
./gradlew --stop
```

---

## 4. IDE 配置

### 4.1 IntelliJ IDEA

#### 安装插件

1. **Scala 插件**
   - Settings → Plugins → 搜索 "Scala"
   - 安装官方 Scala 插件

2. **Scala Enhancement** (可选)
   - 提供更好的语法高亮

#### 导入项目

```bash
# 生成 IDEA 项目文件
./gradlew idea

# 或者直接 IDEA 打开项目
# IDEA 会自动识别 Gradle 项目
```

**步骤:**
1. File → Open → 选择 kafka 目录
2. 选择 "Import project from external model" → Gradle
3. 选择 "Use Gradle wrapper task configuration"
4. 等待索引完成

#### 配置 Scala SDK

1. File → Project Structure → Global Libraries
2. 添加 Scala SDK (2.13.x)
3. 应用到所有模块

#### 配置代码风格

1. Settings → Editor → Code Style → Scala
2. 选择 Scala style guide
3. 或者导入官方代码风格配置

#### 运行配置

**创建 Kafka 主类运行配置:**

1. Run → Edit Configurations
2. 添加新的 Application 配置
3. 配置如下:
   - **Name**：Kafka Server
   - **Main class**：`kafka.Kafka`
   - **VM options**:
     ```
     -Dlog4j.configuration=file:config/log4j2.properties
     ```
   - **Program arguments**：`config/server.properties`
   - **Working directory**：`$MODULE_DIR$`
   - **Use classpath of module**：`kafka.core.main`

#### 常用快捷键

| 操作 | 快捷键 |
|-----|-------|
| 查找类 | Cmd+O (Mac) / Ctrl+N (Win) |
| 查找文件 | Cmd+Shift+O (Mac) / Ctrl+Shift+N (Win) |
| 查找所有 | Double Shift |
| 跳转到定义 | Cmd+B (Mac) / Ctrl+B (Win) |
| 查看文档 | Ctrl+J (Mac) / Ctrl+J (Win) |

### 4.2 VS Code

#### 安装扩展

1. **Scala (Metals)** - Scala 语言支持
2. **Gradle for Java** - Gradle 集成
3. **Code Spell Checker** - 拼写检查

#### 配置

创建 `.vscode/settings.json`:
```json
{
  "scala.metals.javaHome": "/path/to/java-17",
  "metals.excludedPackages": [
    "kafka-.*"
  ],
  "files.exclude": {
    "**/.gradle": true,
    "**/build": true
  }
}
```

### 4.3 Eclipse

```bash
# 生成 Eclipse 项目文件
./gradlew eclipse

# 导入到 Eclipse
# File → Import → Existing Projects into Workspace
```

---

## 5. 调试配置

### 5.1 本地调试

#### 调试 Kafka 主类

**使用 IDEA:**

1. 创建 Debug 配置 (参考 4.1 节)
2. 设置断点
3. 点击 Debug 按钮

**使用命令行:**

```bash
# 启动 Kafka 并监听调试端口
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5005 \
     -cp "core/build/classes/java/main:core/build/scala/main:$(find ~/.gradle/caches -name '*.jar' | tr '\n' ':')" \
     kafka.Kafka config/server.properties

# 然后在 IDE 中连接远程调试到 localhost:5005
```

#### IDEA 远程调试配置

1. Run → Edit Configurations
2. 添加 Remote 配置
3. 配置如下:
   - **Name**：Kafka Remote Debug
   - **Host**：localhost
   - **Port**：5005
   - **Module**：`kafka.core.main`

### 5.2 调试 Broker 启动流程

**设置断点位置:**

```
1. kafka.Kafka.main()
   └→ 程序入口

2. kafka.server.KafkaRaftServer.startup()
   └→ Broker 启动

3. kafka.server.BrokerServer.startup()
   └→ Broker 启动

4. kafka.network.SocketServer.enableRequestProcessing()
   └→ 网络层启动
```

### 5.3 调试 Producer

**创建简单的 Producer:**

```scala
// 文件: SimpleProducer.scala
import java.util.Properties
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object SimpleProducer {
  def main(args: Array[String]): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "localhost:9092")
    props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer")
    props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer")

    val producer = new KafkaProducer[String, String](props)

    val record = new ProducerRecord("test-topic", "key", "value")
    producer.send(record)

    producer.close()
  }
}
```

**调试步骤:**
1. 先启动 Broker (参考 5.2 节)
2. 在 `KafkaProducer.send()` 设置断点
3. 运行 Producer 并调试

### 5.4 调试 Consumer

**创建简单的 Consumer:**

```scala
// 文件: SimpleConsumer.scala
import java.time.Duration
import java.util.Properties
import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer}
import scala.collection.JavaConverters._

object SimpleConsumer {
  def main(args: Array[String]): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "localhost:9092")
    props.put("group.id", "test-group")
    props.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer")
    props.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer")

    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.Collections.singletonList("test-topic"))

    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      for (record <- records.asScala) {
        println(s"Received: ${record.value()}")
      }
    }
  }
}
```

### 5.5 日志配置

**配置 log4j2:**

编辑 `config/log4j2.properties`:
```properties
# 全局日志级别
rootLogger.level=INFO

# Kafka 日志级别
logger.kafka.name=org.apache.kafka
logger.kafka.level=DEBUG

# 网络层日志
logger.network.name=kafka.network
logger.network.level=TRACE

# 存储层日志
logger.log.name=kafka.log
logger.log.level=DEBUG

# 控制台输出
appender.console.type=Console
appender.console.name=STDOUT
appender.console.layout.type=PatternLayout
appender.console.layout.pattern=%d{ISO8601} %-5p [%t] %c{2} (%F:%L) - %m%n

rootLogger.appenderRefs=stdout
rootLogger.appenderRef.stdout.ref=STDOUT
```

---

## 6. 常见问题

### 6.1 构建问题

**问题 1: 内存不足**

```
Error: Java heap space
```

**解决方案:**
```bash
# 增加 Gradle 内存
export GRADLE_OPTS="-Xmx4096m -XX:MaxMetaspaceSize=512m"
```

**问题 2: Scala 版本冲突**

```
Error: Scala version mismatch
```

**解决方案:**
```bash
# 清理并重新构建
./gradlew clean cleanIdea
./gradlew idea
./gradlew build
```

**问题 3: 依赖下载失败**

```
Error: Could not resolve dependency
```

**解决方案:**
```bash
# 配置国内镜像 (可选)
# 创建 ~/.gradle/init.gradle.kts
```

```kotlin
allprojects {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        mavenCentral()
    }
}
```

### 6.2 运行问题

**问题 1: 找不到主类**

```
Error: Could not find or load main class kafka.Kafka
```

**解决方案:**
```bash
# 确保已编译
./gradlew :core:classes

# 使用正确的 classpath
java -cp "$(./gradlew :core:jar -q | grep -E '^.*\.jar$' | head -1):core/build/libs/*" kafka.Kafka
```

**问题 2: 端口已被占用**

```
Error: SocketServer failed to bind to port 9092
```

**解决方案:**
```bash
# 检查端口占用
lsof -i :9092  # macOS/Linux
netstat -ano | findstr :9092  # Windows

# 修改配置
# config/server.properties
listeners=PLAINTEXT://:9093
```

**问题 3: meta.properties 缺失**

```
Error: No meta.properties found in /tmp/kafka-logs
```

**解决方案:**
```bash
# 格式化存储目录
kafka-storage.sh format \
  --config config/server.properties \
  --cluster-id $(kafka-storage.sh random-uuid)
```

### 6.3 调试问题

**问题 1: 断点不生效**

**解决方案:**
1. 确保使用 Debug 模式运行
2. 检查断点是否设置在正确的代码行
3. 尝试重新编译: `./gradlew clean compileScala`

**问题 2: 无法附加调试器**

**解决方案:**
1. 确保调试端口未被占用
2. 检查防火墙设置
3. 使用 `suspend=y` 参数暂停 JVM 等待调试器连接

### 6.4 性能问题

**构建速度慢:**

```bash
# 1. 使用 Gradle 缓存
~/.gradle/gradle.properties:
    org.gradle.caching=true

# 2. 并行构建
~/.gradle/gradle.properties:
    org.gradle.parallel=true

# 3. 使用构建扫描
./gradlew build --scan
```

**IDE 响应慢:**

1. 增加 IDEA 内存
2. 排除不必要的目录
3. 禁用不必要的插件

---

## 7. 开发工作流

### 7.1 典型开发流程

```
1. 拉取最新代码
   git pull origin trunk

2. 编译项目
   ./gradlew build -x test

3. 运行测试 (修改相关的)
   ./gradlew :core:test --tests kafka.server.YourTest

4. 启动 Broker 调试
   使用 IDEA Debug 配置

5. 修改代码
   编辑源文件

6. 热重载 (如果支持)
   IDEA 自动编译

7. 重新测试
   重复步骤 3-6

8. 提交前完整测试
   ./gradlew test

9. 代码格式化
   ./gradlew spotlessScalaCheck
   ./gradlew spotlessScalaApply
```

### 7.2 代码风格检查

```bash
# 检查代码风格
./gradlew spotlessCheck

# 自动修复
./gradlew spotlessApply

# 检查 Scala 代码
./gradlew spotlessScalaCheck

# 检查 Java 代码
./gradlew spotlessJavaCheck
```

### 7.3 性能测试

```bash
# 运行 JMH 基准测试
./gradlew :jmh-benchmarks:jmh

# 运行特定基准测试
./gradlew :jmh-benchmarks:jmh -PjmhInclude='**/LogSegmentBenchmark'
```

---

## 8. 总结

搭建 Kafka 开发环境的关键点:

1. **JDK 17+** 是必需的
2. **Gradle** 是构建工具，使用项目自带的 gradlew
3. **IDEA** 是推荐的 IDE，Scala 支持最好
4. **调试端口 5005** 用于远程调试
5. **meta.properties** 是 KRaft 模式必需的

**推荐配置:**
- JDK 17 或 21
- IntelliJ IDEA + Scala 插件
- 8GB+ 内存
- SSD 硬盘

**下一步:**
1. 成功构建项目
2. 运行一个简单的测试
3. 调试 Broker 启动流程
4. 开始阅读和分析源码

---

## 9. 源码阅读工具推荐

### 9.1 代码导航工具

**IntelliJ IDEA 强力功能:**

1. **类结构视图**
   - `Cmd+F7` (Mac) / `Ctrl+F7` (Win): 查找用法
   - `Cmd+Alt+F7` (Mac) / `Ctrl+Alt+F7` (Win): 显示用法
   - `Cmd+H` (Mac) / `Ctrl+H` (Win): 类型层次结构

2. **快速导航**
   - `Cmd+O` (Mac) / `Ctrl+N` (Win): 查找类
   - `Cmd+Shift+O` (Mac) / `Ctrl+Shift+N` (Win): 查找文件
   - `Cmd+Shift+Alt+N` (Mac) / `Ctrl+Shift+Alt+N` (Win): 查找符号
   - `Alt+Cmd+O` (Mac) / `Alt+Ctrl+Shift+N` (Win): 查找文件中的符号

3. **代码跳转**
   - `Cmd+B` (Mac) / `Ctrl+B` (Win): 跳转到定义
   - `Cmd+Alt+B` (Mac) / `Ctrl+Alt+B` (Win): 跳转到实现
   - `Cmd+U` (Mac) / `Ctrl+U` (Win): 跳转到父类

4. **Scala 特定**
   - `Ctrl+Alt+Shift+←`: 展开 Scala 代码
   - `Ctrl+Alt+Shift+→`: 折叠 Scala 代码

### 9.2 源码可视化工具

**PlantUML / Mermaid**
- 生成类图和时序图
- IDEA 插件: PlantUML integration
- 示例: 生成 `kafka.server.KafkaApis` 的调用关系图

**理解依赖关系:**
```bash
# 使用 Gradle 查看依赖树
./gradlew :core:dependencies --configuration compileClasspath

# 生成依赖报告
./gradlew :core:dependencyInsight --dependency scala-library
```

### 9.3 性能分析工具

**JProfiler**
- 下载: https://www.ej-technologies.com/products/jprofiler/overview
- IDEA 集成: 安装 JProfiler 插件
- 用途:
  - CPU 性能分析
  - 内存泄漏检测
  - 线程死锁检测

**VisualVM**
- 免费: https://visualvm.github.io/
- JDK 自带 (JDK 8) 或单独安装
- 用途:
  - 监控堆内存
  - 线程分析
  - GC 分析

**Async Profiler**
- GitHub: https://github.com/jvm-profiling-tools/async-profiler
- Java 11+ 性能分析工具
- 低开销的 CPU 和内存分析

### 9.4 日志分析工具

**Kafka Tool**
- 下载: https://www.kafkatool.com/
- 功能:
  - 浏览 Topic 和消息
  - 查看 Offset
  - 管理 Consumer Group

**kcat (原名 kafkacat)**
- 命令行工具
- GitHub: https://github.com/edenhill/kcat
- 用途:
  - 生产/消费消息
  - 查看 Offset
  - 调试 Broker

---

## 10. 调试技巧与断点设置

### 10.1 关键断点位置

**Broker 启动流程:**
```scala
// 1. 主入口
kafka.Kafka.main()

// 2. KRaft Broker 启动
kafka.server.KafkaRaftServer.startup()
kafka.server.KafkaRaftServer.startup() // 行: 120

// 3. Broker 进程启动
kafka.server.BrokerServer.startup()
kafka.server.BrokerServer.initialize() // 行: 89

// 4. 网络层启动
kafka.network.SocketServer.enableRequestProcessing()
kafka.network.SocketServer.startProcessors() // 行: 368

// 5. 日志管理器启动
kafka.log.LogManager.startup()
kafka.log.LogManager.loadLogs() // 行: 95
```

**Producer 发送消息:**
```java
// 客户端路径
org.apache.kafka.clients.producer.KafkaProducer.send()
  -> org.apache.kafka.clients.producer.internals.Sender.run()
  -> org.apache.kafka.clients.producer.internals.Sender.sendProducerData()
  -> org.apache.kafka.clients.NetworkClient.send()

// 服务端路径
kafka.server.KafkaApis.handleProduceRequest()
  -> kafka.server.ReplicaManager.appendRecords()
  -> kafka.log.Log.append()
  -> kafka.log.LogSegment.append()
```

**Consumer 消费消息:**
```java
// 客户端路径
org.apache.kafka.clients.consumer.KafkaConsumer.poll()
  -> org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.poll()
  -> org.apache.kafka.clients.consumer.internals.Fetcher.fetchRecords()

// 服务端路径
kafka.server.KafkaApis.handleFetchRequest()
  -> kafka.server.ReplicaManager.fetchMessages()
  -> kafka.log.Log.read()
```

### 10.2 条件断点技巧

**示例 1: 只调试特定 Topic**
```
位置: kafka.server.KafkaApis.handleProduceRequest()
条件: requestData.topicName == "my-topic"
```

**示例 2: 只调试特定分区**
```
位置: kafka.log.Log.append()
条件: topicPartition.partition == 0
```

**示例 3: 调试重试逻辑**
```
位置: org.apache.kafka.clients.producer.internals.Sender.run()
条件: retries > 0
```

### 10.3 日志断点

在 IDEA 中设置日志断点（不暂停程序，只打印日志）:

```
位置: kafka.server.KafkaApis.handleProduceRequest()
日志表达式: "Produce to topic: " + requestData.topicName + ", partition: " + requestData.partition
```

### 10.4 异常断点

捕获特定异常:

1. Run → View Breakpoints
2. 添加 Java Exception Breakpoint
3. 常用异常:
   - `kafka.common.KafkaException`
   - `java.io.IOException`
   - `org.apache.kafka.common.errors.*`

### 10.5 字段断点

监控对象字段变化:

```
位置: kafka.cluster.Partition
字段: leaderEpoch
用途: 跟踪 Leader 变更
```

---

## 11. 常见开发问题解决

### 11.1 性能分析

**问题: 构建速度慢**

解决方案:
```bash
# 1. 启用 Gradle 缓存
~/.gradle/gradle.properties:
  org.gradle.caching=true

# 2. 并行构建
~/.gradle/gradle.properties:
  org.gradle.parallel=true

# 3. 配置内存
~/.gradle/gradle.properties:
  org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError

# 4. 使用构建缓存
./gradlew clean build --build-cache

# 5. 跳过不必要的任务
./gradlew build -x test -x javadoc -x scaladoc
```

**问题: IDEA 索引慢**

解决方案:
1. 排除不必要的目录:
   ```
   Settings → Project Structure → Modules
   排除: .gradle, build, gradle
   ```

2. 增加 IDEA 内存:
   ```
   Help → Edit Custom VM Options
   -Xms2048m
   -Xmx4096m
   ```

3. 禁用不必要的插件:
   ```
   Settings → Plugins
   禁用不常用的插件
   ```

### 11.2 调试问题

**问题: 断点不生效**

排查步骤:
1. 确保使用 Debug 模式运行
2. 检查代码是否重新编译
3. 尝试清理缓存:
   ```bash
   ./gradlew clean cleanIdea
   ./gradlew idea
   ```
4. 检查断点设置是否正确

**问题: 无法连接远程调试**

排查步骤:
1. 检查调试端口是否占用:
   ```bash
   lsof -i :5005
   ```
2. 确认 JVM 参数正确:
   ```
   -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005
   ```
3. 检查防火墙设置
4. 尝试使用 `suspend=y` 暂停 JVM 等待调试器

**问题: 热部署不生效**

解决方案:
```java
// IDEA 配置
1. Settings → Build, Execution, Deployment → Compiler
   勾选 "Build project automatically"

2. Settings → Advanced Settings
   勾选 "Allow auto-make to start even if developed application is currently running"

// 注意: Scala 代码热部署支持有限
// 建议使用 Java 客户端代码进行快速迭代
```

### 11.3 测试问题

**问题: 测试运行失败**

常见原因:
1. 端口冲突:
   ```bash
   # 检查并释放端口
   lsof -i :9092
   lsof -i :9093
   ```

2. 临时目录未清理:
   ```bash
   # 清理 Kafka 临时文件
   rm -rf /tmp/kafka-*
   rm -rf /tmp/zookeeper
   ```

3. 测试超时:
   ```bash
   # 增加测试超时时间
   ./gradlew test --timeout=600
   ```

**问题: 单元测试运行慢**

优化方案:
```bash
# 1. 只运行特定测试
./gradlew :core:test --tests kafka.server.KafkaServerTest

# 2. 并行运行测试
./gradlew test --parallel

# 3. 跳过集成测试
./gradlew test -x integrationTest

# 4. 使用测试过滤器
./gradlew test --tests "*ProducerTest"
```

---

## 12. 代码贡献指南

### 12.1 贡献流程

1. **Fork 仓库**
   ```
   GitHub: https://github.com/apache/kafka
   点击 Fork 按钮
   ```

2. **创建分支**
   ```bash
   git checkout -b feature-your-feature
   ```

3. **编写代码**
   - 遵循代码风格
   - 添加单元测试
   - 更新文档

4. **运行测试**
   ```bash
   # 完整测试
   ./gradlew test

   # 代码风格检查
   ./gradlew spotlessCheck

   # 自动格式化
   ./gradlew spotlessApply
   ```

5. **提交 Pull Request**
   - 在 GitHub 上创建 PR
   - 填写 PR 模板
   - 等待 CI 检查通过

### 12.2 代码风格检查

```bash
# 检查代码风格
./gradlew spotlessCheck

# 自动修复
./gradlew spotlessApply

# 检查特定模块
./gradlew :core:spotlessScalaCheck
./gradlew :clients:spotlessJavaCheck
```

### 12.3 提交规范

```
Commit Message 格式:

<KIP-XXX>: <简短描述> (50字符以内)

<详细描述>

- 为什么需要这个改动
- 做了什么改动
- 如何测试

Fixes #<Issue 编号>
```

示例:
```
KIP-500: Add support for custom partitioner

This KIP adds support for custom partitioner in Producer.
The new interface allows users to implement their own
partitioning logic.

Changes:
- Add CustomPartitioner interface
- Update DefaultPartitioner
- Add unit tests

Testing:
- Added unit tests for CustomPartitioner
- Manual testing with example Producer

Fixes #12345
```

---

## 13. 版本特性对比

### 13.1 Kafka 3.x 主要特性

| 特性 | 3.0 | 3.1 | 3.2 | 3.3 | 3.4 | 3.5 | 3.6 | 3.7 |
|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| **KRaft GA** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ZooKeeper 弃用** | 📢 | 📢 | 📢 | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **消费者组滚动升级** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Controller 改进** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **性能优化** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **新 API** | - | - | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 13.2 选择学习版本

**推荐版本:**

1. **学习最新特性**：`trunk` 分支
   - 优点: 最新功能和改进
   - 缺点: 可能有不稳定的变化

2. **稳定学习**：`3.7.x` 分支
   - 优点: 稳定的 API 和实现
   - 缺点: 没有最新特性

3. **生产对应**：选择你的生产环境版本
   - 优点: 直接相关
   - 缺点: 可能缺少新特性

**切换版本:**
```bash
# 查看所有分支
git branch -a

# 切换到 3.7 分支
git checkout 3.7

# 切换到 trunk
git checkout trunk
```

### 13.3 KIP 重要改进

**重要 KIP 列表:**

- **KIP-500**: Replace ZooKeeper with a Self-Managed Metadata Quorum
- **KIP-732**: Controller Registration in KRaft
- **KIP-848**: The Next Generation of the Consumer Group Rebalance Protocol
- **KIP-733**: Structured Key Headers
- **KIP-779**: Offset Fetch Session Cache
- **KIP-890**: Share Groups

查看所有 KIP:
```
https://cwiki.apache.org/confluence/display/KAFKA/Kafka+Improvement+Proposals
```

---

## 14. 性能基准测试

### 14.1 运行 JMH 基准测试

```bash
# 运行所有基准测试
./gradlew :jmh-benchmarks:jmh

# 运行特定基准测试
./gradlew :jmh-benchmarks:jmh -PjmhInclude='**/LogSegmentBenchmark'

# 生成报告
./gradlew :jmh-benchmarks:jmh -PjmhGenerateReports=true
```

### 14.2 Producer 性能测试

```bash
# 使用 kafka-producer-perf-test.sh
bin/kafka-producer-perf-test.sh \
  --topic test-topic \
  --num-records 1000000 \
  --record-size 1024 \
  --throughput 10000 \
  --producer-props \
    bootstrap.servers=localhost:9092 \
    acks=1
```

### 14.3 Consumer 性能测试

```bash
# 使用 kafka-consumer-perf-test.sh
bin/kafka-consumer-perf-test.sh \
  --topic test-topic \
  --messages 1000000 \
  --threads 1 \
  --broker-list localhost:9092
```

---

## 15. 总结

搭建 Kafka 开发环境的关键点:

1. **JDK 17+** 是必需的
2. **Gradle** 是构建工具，使用项目自带的 gradlew
3. **IDEA** 是推荐的 IDE，Scala 支持最好
4. **调试端口 5005** 用于远程调试
5. **meta.properties** 是 KRaft 模式必需的

**推荐配置:**
- JDK 17 或 21
- IntelliJ IDEA + Scala 插件
- 8GB+ 内存
- SSD 硬盘

**开发最佳实践:**
1. 使用版本控制
2. 编写单元测试
3. 遵循代码风格
4. 定期同步上游
5. 参与社区讨论

**下一步:**
1. 成功构建项目
2. 运行一个简单的测试
3. 调试 Broker 启动流程
4. 开始阅读和分析源码

---

**下一步**：[03. KafkaServer 启动流程详解](../01-server-startup/01-kafkaserver-startup.md)
