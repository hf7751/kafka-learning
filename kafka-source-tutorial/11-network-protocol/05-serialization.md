# 05. 序列化机制

Kafka 使用自定义的序列化机制来实现高效的数据传输。本文深入分析 Kafka 的序列化体系，包括内置序列化器、协议类型系统以及 Schema 演进机制。

## 目录
- [1. 序列化概述](#1-序列化概述)
- [2. 内置序列化器](#2-内置序列化器)
- [3. 协议类型系统](#3-协议类型系统)
- [4. 自定义序列化器](#4-自定义序列化器)
- [5. Schema 演进](#5-schema-演进)

---

## 1. 序列化概述

### 1.1 序列化在 Kafka 中的位置

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层                                   │
│              (业务对象: User, Order, Event)                  │
└───────────────────────┬─────────────────────────────────────┘
                        │ 序列化
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Kafka Producer                             │
│              (Serializer 接口)                              │
│         ┌─────────────────────────────┐                     │
│         │  StringSerializer           │                     │
│         │  ByteArraySerializer        │                     │
│         │  JsonSerializer             │                     │
│         │  AvroSerializer             │                     │
│         └─────────────────────────────┘                     │
└───────────────────────┬─────────────────────────────────────┘
                        │ byte[]
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                 网络传输层                                  │
│              (TCP + Kafka Protocol)                         │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Serializer 接口

**源码位置**: `clients/src/main/java/org/apache/kafka/common/serialization/Serializer.java`

```java
public interface Serializer<T> extends Closeable {

    /**
     * 配置序列化器
     * @param configs 生产者/消费者配置
     * @param isKey 是否用于序列化 key
     */
    default void configure(Map<String, ?> configs, boolean isKey) {
        // 默认空实现
    }

    /**
     * 将对象序列化为 byte 数组
     * @param topic 目标 topic（可能为 null）
     * @param data 待序列化的数据
     * @return 序列化后的字节数组
     */
    byte[] serialize(String topic, T data);

    /**
     * 带 Headers 的序列化方法（Kafka 0.11+）
     */
    default byte[] serialize(String topic, Headers headers, T data) {
        return serialize(topic, data);
    }

    /**
     * 关闭序列化器，释放资源
     */
    @Override
    default void close() {
        // 默认空实现
    }
}
```

### 1.3 Deserializer 接口

**源码位置**: `clients/src/main/java/org/apache/kafka/common/serialization/Deserializer.java`

```java
public interface Deserializer<T> extends Closeable {

    default void configure(Map<String, ?> configs, boolean isKey) {
        // 默认空实现
    }

    /**
     * 将 byte 数组反序列化为对象
     */
    T deserialize(String topic, byte[] data);

    /**
     * 带 Headers 的反序列化方法
     */
    default T deserialize(String topic, Headers headers, byte[] data) {
        return deserialize(topic, data);
    }

    @Override
    default void close() {
        // 默认空实现
    }
}
```

### 1.4 序列化与消息格式

```
┌────────────────────────────────────────────────────────────┐
│                     RecordBatch (V2)                       │
├────────────────────────────────────────────────────────────┤
│  Record 1                                                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Length (varint)                                    │  │
│  │  Attributes (varint)                                │  │
│  │  Timestamp Delta (varlong)                          │  │
│  │  Offset Delta (varint)                              │  │
│  │  Key Length (varint) │ Key Bytes (序列化后的 key)    │  │
│  │  Value Length (varint) │ Value Bytes (序列化后的 value)│ │
│  │  Headers Count (varint)                             │  │
│  └─────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────┤
│  Record 2 ...                                              │
└────────────────────────────────────────────────────────────┘
        ↑                              ↑
   Serializer<T>                   Deserializer<T>
```

---

## 2. 内置序列化器

### 2.1 ByteArraySerializer

最简单的序列化器，直接透传字节数组。

```java
public class ByteArraySerializer implements Serializer<byte[]> {

    @Override
    public byte[] serialize(String topic, byte[] data) {
        return data;  // 直接返回，不做任何转换
    }
}

public class ByteArrayDeserializer implements Deserializer<byte[]> {

    @Override
    public byte[] deserialize(String topic, byte[] data) {
        return data;  // 直接返回
    }
}
```

**使用场景**: 消息已经是字节数组格式，或需要自定义序列化逻辑。

### 2.2 StringSerializer

支持多种字符集的字符串序列化器。

```java
public class StringSerializer implements Serializer<String> {

    private String encoding = StandardCharsets.UTF_8.name();

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        String propertyName = isKey ? "key.serializer.encoding"
                                    : "value.serializer.encoding";
        Object encodingValue = configs.get(propertyName);
        if (encodingValue == null)
            encodingValue = configs.get("serializer.encoding");
        if (encodingValue instanceof String)
            encoding = (String) encodingValue;
    }

    @Override
    public byte[] serialize(String topic, String data) {
        try {
            if (data == null)
                return null;
            else
                return data.getBytes(encoding);
        } catch (UnsupportedEncodingException e) {
            throw new SerializationException(
                "Error when serializing string to byte[] due to unsupported encoding " + encoding);
        }
    }
}
```

**配置选项**:
| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| `serializer.encoding` | UTF-8 | 全局默认编码 |
| `key.serializer.encoding` | UTF-8 | Key 的编码 |
| `value.serializer.encoding` | UTF-8 | Value 的编码 |

### 2.3 Integer/Long/Double Serializers

基本数值类型的序列化器。

```java
public class IntegerSerializer implements Serializer<Integer> {

    @Override
    public byte[] serialize(String topic, Integer data) {
        if (data == null)
            return null;

        return new byte[] {
            (byte) (data >>> 24),
            (byte) (data >>> 16),
            (byte) (data >>> 8),
            data.byteValue()
        };
    }
}

public class LongSerializer implements Serializer<Long> {

    @Override
    public byte[] serialize(String topic, Long data) {
        if (data == null)
            return null;

        long value = data;
        return new byte[] {
            (byte) (value >>> 56),
            (byte) (value >>> 48),
            (byte) (value >>> 40),
            (byte) (value >>> 32),
            (byte) (value >>> 24),
            (byte) (value >>> 16),
            (byte) (value >>> 8),
            (byte) value
        };
    }
}

public class DoubleSerializer implements Serializer<Double> {

    @Override
    public byte[] serialize(String topic, Double data) {
        if (data == null)
            return null;

        long value = Double.doubleToRawLongBits(data);
        return new byte[] {
            (byte) (value >>> 56),
            (byte) (value >>> 48),
            // ... 类似 LongSerializer
        };
    }
}
```

**字节序**: 使用大端序（Big-Endian），高位字节在前。

### 2.4 UUID Serializer

Kafka 2.1+ 引入的 UUID 序列化器。

```java
public class UUIDSerializer implements Serializer<UUID> {

    @Override
    public byte[] serialize(String topic, UUID data) {
        if (data == null)
            return null;

        ByteBuffer buffer = ByteBuffer.wrap(new byte[16]);
        buffer.putLong(data.getMostSignificantBits());
        buffer.putLong(data.getLeastSignificantBits());
        return buffer.array();
    }
}

public class UUIDDeserializer implements Deserializer<UUID> {

    @Override
    public UUID deserialize(String topic, byte[] data) {
        if (data == null)
            return null;

        if (data.length != 16) {
            throw new SerializationException(
                "Error deserializing UUID, expected 16 bytes, received " + data.length);
        }

        ByteBuffer buffer = ByteBuffer.wrap(data);
        long mostSigBits = buffer.getLong();
        long leastSigBits = buffer.getLong();
        return new UUID(mostSigBits, leastSigBits);
    }
}
```

### 2.5 Void Serializer

用于 null 值的序列化器。

```java
public class VoidSerializer implements Serializer<Void> {

    @Override
    public byte[] serialize(String topic, Void data) {
        return null;  // 始终返回 null
    }
}

public class VoidDeserializer implements Deserializer<Void> {

    @Override
    public Void deserialize(String topic, byte[] data) {
        return null;  // 始终返回 null
    }
}
```

**使用场景**: 仅使用 Key 来路由消息，Value 不需要传输数据。

---

## 3. 协议类型系统

### 3.1 Type 接口

**源码位置**: `clients/src/main/java/org/apache/kafka/common/protocol/types/Type.java`

```java
public abstract class Type {

    /**
     * 写入类型到 ByteBuffer
     */
    public abstract void write(ByteBuffer buffer, Object o);

    /**
     * 从 ByteBuffer 读取类型
     */
    public abstract Object read(ByteBuffer buffer);

    /**
     * 计算对象序列化后的大小
     */
    public abstract int sizeOf(Object o);

    /**
     * 验证对象是否有效
     */
    public abstract void validate(Object o);

    /**
     * 类型名称
     */
    public abstract String typeName();

    /**
     * 是否为可变长度类型
     */
    public boolean isNullable() {
        return false;
    }
}
```

### 3.2 基本类型

```java
// INT8 - 1 字节有符号整数
public static final Type INT8 = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        buffer.put((Byte) o);
    }

    @Override
    public Object read(ByteBuffer buffer) {
        return buffer.get();
    }

    @Override
    public int sizeOf(Object o) {
        return 1;
    }

    // ... 其他方法
};

// INT16 - 2 字节有符号整数（大端序）
public static final Type INT16 = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        buffer.putShort((Short) o);
    }

    @Override
    public Object read(ByteBuffer buffer) {
        return buffer.getShort();
    }

    @Override
    public int sizeOf(Object o) {
        return 2;
    }
};

// INT32 - 4 字节有符号整数
public static final Type INT32 = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        buffer.putInt((Integer) o);
    }

    @Override
    public int sizeOf(Object o) {
        return 4;
    }
    // ...
};

// INT64 - 8 字节有符号整数
public static final Type INT64 = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        buffer.putLong((Long) o);
    }

    @Override
    public int sizeOf(Object o) {
        return 8;
    }
    // ...
};

// UINT16 - 2 字节无符号整数
// UINT32 - 4 字节无符号整数
```

### 3.3 字符串类型

```java
// STRING - 长度(2 bytes) + 内容
public static final Type STRING = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        byte[] bytes = Utils.utf8((String) o);
        if (bytes.length > Short.MAX_VALUE)
            throw new SchemaException("String is longer than the maximum string length");
        buffer.putShort((short) bytes.length);
        buffer.put(bytes);
    }

    @Override
    public Object read(ByteBuffer buffer) {
        int length = buffer.getShort();
        if (length < 0)
            throw new SchemaException("String length is negative");
        byte[] bytes = new byte[length];
        buffer.get(bytes);
        return Utils.utf8(bytes);
    }

    @Override
    public int sizeOf(Object o) {
        return 2 + Utils.utf8Length((String) o);
    }
};

// NULLABLE_STRING - 可为 null 的字符串
public static final Type NULLABLE_STRING = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        if (o == null) {
            buffer.putShort((short) -1);
            return;
        }
        byte[] bytes = Utils.utf8((String) o);
        if (bytes.length > Short.MAX_VALUE)
            throw new SchemaException("String is longer than the maximum string length");
        buffer.putShort((short) bytes.length);
        buffer.put(bytes);
    }

    @Override
    public Object read(ByteBuffer buffer) {
        int length = buffer.getShort();
        if (length < 0)
            return null;
        byte[] bytes = new byte[length];
        buffer.get(bytes);
        return Utils.utf8(bytes);
    }

    @Override
    public boolean isNullable() {
        return true;
    }
};

// COMPACT_STRING - 紧凑字符串（Varint 长度编码）
public static final Type COMPACT_STRING = new Type() {
    @Override
    public void write(ByteBuffer buffer, Object o) {
        byte[] bytes = Utils.utf8((String) o);
        ByteUtils.writeUnsignedVarint(bytes.length + 1, buffer);
        buffer.put(bytes);
    }

    @Override
    public Object read(ByteBuffer buffer) {
        int length = ByteUtils.readUnsignedVarint(buffer) - 1;
        if (length < 0)
            throw new SchemaException("Compact string length is negative");
        byte[] bytes = new byte[length];
        buffer.get(bytes);
        return Utils.utf8(bytes);
    }

    @Override
    public int sizeOf(Object o) {
        byte[] bytes = Utils.utf8((String) o);
        return ByteUtils.sizeOfUnsignedVarint(bytes.length + 1) + bytes.length;
    }
};
```

### 3.4 数组类型

```java
// ARRAY - 长度(4 bytes) + 元素
public static DocumentedType ARRAY(Type elementType) {
    return new DocumentedType() {
        @Override
        public void write(ByteBuffer buffer, Object o) {
            Object[] objs = (Object[]) o;
            buffer.putInt(objs.length);
            for (Object obj : objs)
                elementType.write(buffer, obj);
        }

        @Override
        public Object read(ByteBuffer buffer) {
            int size = buffer.getInt();
            if (size < 0)
                throw new SchemaException("Array size is negative");
            Object[] objs = new Object[size];
            for (int i = 0; i < size; i++)
                objs[i] = elementType.read(buffer);
            return objs;
        }

        @Override
        public int sizeOf(Object o) {
            Object[] objs = (Object[]) o;
            int size = 4;  // 长度字段
            for (Object obj : objs)
                size += elementType.sizeOf(obj);
            return size;
        }
    };
}

// COMPACT_ARRAY - 紧凑数组（Varint 长度编码）
public static DocumentedType COMPACT_ARRAY(Type elementType) {
    return new DocumentedType() {
        @Override
        public void write(ByteBuffer buffer, Object o) {
            Object[] objs = (Object[]) o;
            ByteUtils.writeUnsignedVarint(objs.length + 1, buffer);
            for (Object obj : objs)
                elementType.write(buffer, obj);
        }

        @Override
        public Object read(ByteBuffer buffer) {
            int size = ByteUtils.readUnsignedVarint(buffer) - 1;
            if (size < 0)
                throw new SchemaException("Compact array size is negative");
            Object[] objs = new Object[size];
            for (int i = 0; i < size; i++)
                objs[i] = elementType.read(buffer);
            return objs;
        }
    };
}
```

### 3.5 复杂类型

```java
// STRUCT - 结构体类型
public static class Schema {
    private final Field[] fields;
    private final Map<String, Field> fieldsByName;

    public Schema(Field... fields) {
        this.fields = fields;
        this.fieldsByName = new HashMap<>();
        for (Field field : fields)
            fieldsByName.put(field.name, field);
    }

    public void write(ByteBuffer buffer, Struct struct) {
        for (Field field : fields) {
            Object value = struct.get(field);
            field.type.write(buffer, value);
        }
    }

    public Struct read(ByteBuffer buffer) {
        Struct struct = new Struct(this);
        for (Field field : fields) {
            Object value = field.type.read(buffer);
            struct.set(field, value);
        }
        return struct;
    }
}

// 使用示例：定义 ProduceRequest 的 Schema
public static final Schema PRODUCE_REQUEST_V0 = new Schema(
    new Field("acks", INT16, "The number of acknowledgments required"),
    new Field("timeout", INT32, "The time to await a response"),
    new Field("topic_data", ARRAY(TopicData.SCHEMA), "Per-topic data")
);
```

---

## 4. 自定义序列化器

### 4.1 实现 Serializer 接口

```java
public class JsonSerializer<T> implements Serializer<T> {

    private ObjectMapper objectMapper;
    private Class<T> targetType;

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        objectMapper = new ObjectMapper();
        objectMapper.registerModule(new JavaTimeModule());
        objectMapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

        // 从配置中获取目标类型
        String typeConfig = isKey ? "json.key.type" : "json.value.type";
        String typeClass = (String) configs.get(typeConfig);
        if (typeClass != null) {
            try {
                targetType = (Class<T>) Class.forName(typeClass);
            } catch (ClassNotFoundException e) {
                throw new SerializationException("Cannot find class: " + typeClass, e);
            }
        }
    }

    @Override
    public byte[] serialize(String topic, T data) {
        if (data == null)
            return null;

        try {
            return objectMapper.writeValueAsBytes(data);
        } catch (JsonProcessingException e) {
            throw new SerializationException(
                "Error serializing JSON message", e);
        }
    }

    @Override
    public void close() {
        // 清理资源
    }
}
```

### 4.2 实现 Deserializer 接口

```java
public class JsonDeserializer<T> implements Deserializer<T> {

    private ObjectMapper objectMapper;
    private Class<T> targetType;

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        objectMapper = new ObjectMapper();
        objectMapper.registerModule(new JavaTimeModule());

        // 获取目标类型
        String typeConfig = isKey ? "json.key.type" : "json.value.type";
        String typeClass = (String) configs.get(typeConfig);
        if (typeClass == null) {
            throw new ConfigException(
                "JSON deserializer requires config: " + typeConfig);
        }

        try {
            targetType = (Class<T>) Class.forName(typeClass);
        } catch (ClassNotFoundException e) {
            throw new SerializationException("Cannot find class: " + typeClass, e);
        }
    }

    @Override
    public T deserialize(String topic, byte[] data) {
        if (data == null)
            return null;

        try {
            return objectMapper.readValue(data, targetType);
        } catch (IOException e) {
            throw new SerializationException(
                "Error deserializing JSON message", e);
        }
    }

    @Override
    public void close() {
        // 清理资源
    }
}
```

### 4.3 JSON 序列化示例

```java
// 定义消息对象
public class UserEvent {
    private String userId;
    private String action;
    private Instant timestamp;
    private Map<String, Object> metadata;

    // Getters and setters...
}

// 生产者配置
Properties props = new Properties();
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
    StringSerializer.class.getName());
props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
    JsonSerializer.class.getName());
props.put("json.value.type", UserEvent.class.getName());

KafkaProducer<String, UserEvent> producer = new KafkaProducer<>(props);

// 发送消息
UserEvent event = new UserEvent();
event.setUserId("user-123");
event.setAction("login");
event.setTimestamp(Instant.now());

producer.send(new ProducerRecord<>("user-events", event.getUserId(), event));
```

### 4.4 Protobuf 序列化示例

```java
public class ProtobufSerializer<T extends GeneratedMessageV3>
        implements Serializer<T> {

    @Override
    public byte[] serialize(String topic, T data) {
        if (data == null)
            return null;
        return data.toByteArray();
    }
}

public class ProtobufDeserializer<T extends GeneratedMessageV3>
        implements Deserializer<T> {

    private Parser<T> parser;

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        String parserClass = (String) configs.get(
            isKey ? "protobuf.key.parser" : "protobuf.value.parser");
        try {
            Class<?> clazz = Class.forName(parserClass);
            Method getParser = clazz.getMethod("parser");
            this.parser = (Parser<T>) getParser.invoke(null);
        } catch (Exception e) {
            throw new SerializationException("Failed to initialize Protobuf parser", e);
        }
    }

    @Override
    public T deserialize(String topic, byte[] data) {
        if (data == null)
            return null;
        try {
            return parser.parseFrom(data);
        } catch (InvalidProtocolBufferException e) {
            throw new SerializationException("Failed to parse Protobuf message", e);
        }
    }
}
```

---

## 5. Schema 演进

### 5.1 Schema 注册中心

```
┌─────────────────────────────────────────────────────────────┐
│                      Producer                               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │  UserEvent  │───→│ Avro Serializer │───→│  Schema     │     │
│  │   Object    │    │             │    │  Registry   │     │
│  └─────────────┘    └─────────────┘    └──────┬──────┘     │
└─────────────────────────────────────────────────┼───────────┘
                                                  │ Register/Get ID
                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                   Schema Registry                           │
│              (Confluent / Apicurio)                         │
│                                                             │
│   Schema ID 1: UserEvent_v1.avsc                            │
│   Schema ID 2: UserEvent_v2.avsc                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                                                  ▲
                                                  │ Get Schema by ID
┌─────────────────────────────────────────────────┼───────────┐
│                      Consumer                   │           │
│  ┌─────────────┐    ┌─────────────┐    ┌────────┴────┐     │
│  │  UserEvent  │←───│ Avro Deserializer │←───│  Schema     │     │
│  │   Object    │    │             │    │  Registry   │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Avro 与 Schema Evolution

**Avro Schema 示例**:

```json
{
  "type": "record",
  "name": "UserEvent",
  "namespace": "com.example.kafka",
  "fields": [
    {"name": "userId", "type": "string"},
    {"name": "action", "type": "string"},
    {"name": "timestamp", "type": "long"},
    {"name": "metadata",
     "type": ["null", {"type": "map", "values": "string"}],
     "default": null}
  ]
}
```

**Avro 序列化器实现**:

```java
public class AvroSerializer<T extends SpecificRecordBase>
        implements Serializer<T> {

    private SchemaRegistryClient schemaRegistry;
    private KafkaAvroSerializer inner;

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        Map<String, Object> config = new HashMap<>(configs);
        config.put("schema.registry.url",
            configs.get("schema.registry.url"));

        inner = new KafkaAvroSerializer(schemaRegistry, config);
    }

    @Override
    public byte[] serialize(String topic, T data) {
        return inner.serialize(topic, data);
    }

    @Override
    public void close() {
        inner.close();
    }
}
```

### 5.3 兼容性规则

| 兼容性类型 | 说明 | 允许的操作 |
|-----------|------|-----------|
| **BACKWARD** | 新版本消费者可以读取旧数据 | 删除字段（有默认值）、添加字段（可选） |
| **FORWARD** | 旧版本消费者可以读取新数据 | 添加字段（有默认值）、删除字段（可选） |
| **FULL** | 双向兼容 | 添加可选字段、删除可选字段 |
| **NONE** | 无兼容性保证 | 任意修改 |

```
BACKWARD Compatibility:
┌─────────────────┐         ┌─────────────────┐
│  Consumer v2    │         │  Consumer v1    │
│  (new schema)   │   ✓     │  (old schema)   │
│                 │ ───────→│                 │
│  {              │         │  {              │
│    userId,      │         │    userId,      │
│    action,      │         │    action,      │
│    timestamp,   │         │    timestamp    │
│    metadata     │         │  }              │
│  }              │         │                 │
└─────────────────┘         └─────────────────┘
        ↑                           ↑
        │                           ✗
┌───────┴─────────┐         ┌───────┴─────────┐
│  Producer       │         │  Producer       │
│  (old data)     │         │  (new data)     │
└─────────────────┘         └─────────────────┘

FORWARD Compatibility:
┌─────────────────┐         ┌─────────────────┐
│  Consumer v2    │         │  Consumer v1    │
│  (new schema)   │   ✗     │  (old schema)   │
│                 │ ←───────│                 │
└─────────────────┘         └─────────────────┘
        ↑                           ↑
        ✓                           ↑
┌───────┴─────────┐         ┌───────┴─────────┐
│  Producer       │         │  Producer       │
│  (old data)     │         │  (new data)     │
└─────────────────┘         └─────────────────┘
```

### 5.4 Kafka 与 Schema Registry 集成

**生产者配置**:
```java
Properties props = new Properties();
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
    StringSerializer.class.getName());
props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
    KafkaAvroSerializer.class.getName());
props.put("schema.registry.url", "http://localhost:8081");

// Avro 兼容性级别
props.put("avro.compatibility.level", "BACKWARD");
```

**消费者配置**:
```java
Properties props = new Properties();
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
    StringDeserializer.class.getName());
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
    KafkaAvroDeserializer.class.getName());
props.put("schema.registry.url", "http://localhost:8081");

// 是否使用特定的 reader schema
props.put(KafkaAvroDeserializerConfig.SPECIFIC_AVRO_READER_CONFIG, "true");
```

**Schema 演进最佳实践**:

1. **始终提供默认值**
```json
{"name": "newField", "type": ["null", "string"], "default": null}
```

2. **避免重命名字段**（Avro 视为新字段）
3. **不要更改字段类型**（可能导致数据丢失）
4. **删除字段时确保已废弃**
5. **在测试环境验证兼容性变化**

---

## 总结

| 序列化方式 | 优点 | 缺点 | 适用场景 |
|-----------|------|------|---------|
| **String** | 可读性强，易于调试 | 体积大，效率低 | 日志、简单文本消息 |
| **JSON** | 通用，可读性强 | 无 Schema，体积大 | 快速开发，动态结构 |
| **Avro** | 体积小，Schema 演进 | 需要 Schema Registry | 大规模生产环境 |
| **Protobuf** | 性能高，跨语言 | 需要代码生成 | 微服务通信 |
| **ByteArray** | 零开销 | 无类型安全 | 自定义二进制格式 |

---

**上一篇**: [04. 版本协商机制](./04-version-negotiation.md)
**下一篇**: [06. NetworkClient 网络客户端实现](./06-network-client.md)
