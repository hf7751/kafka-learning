import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// VitePress 项目根 = 仓库根
// srcDir = kafka-source-tutorial （教程 markdown 源目录，不移动文件以保留相对链接）
// 首页 index.md 位于 kafka-source-tutorial/index.md
export default withMermaid(
  defineConfig({
    lang: 'zh-CN',
    title: 'Kafka 源码分析教程',
    description:
      '深入浅出的 Kafka 4.x 源码分析教程，涵盖启动流程、日志存储、副本管理、Controller、事务、Producer/Consumer 等核心机制',
    srcDir: 'kafka-source-tutorial',
    outDir: 'docs',
    cleanUrls: true,
    lastUpdated: true,

    // 教程内存在指向各章节 README.md 的链接，写法不一（有的写 dir/index，有的写 dir/）。
    // 这些是合理的章节导览跳转，VitePress 路由约定下会被判为死链，故忽略。
    ignoreDeadLinks: [
      /\/index$/, // 指向章节目录索引的链接（README.md 在源码中以 index 形式被引用）
      /\/index\.md$/ // 同上，带 .md 后缀
    ],

    head: [
      ['meta', { name: 'theme-color', content: '#23A5Fx' }],
      ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]
    ],

    markdown: {
      lineNumbers: false
    },

    locales: {
      root: {
        label: '简体中文',
        lang: 'zh-CN'
      }
    },

    themeConfig: {
      siteTitle: 'Kafka 源码分析',

      nav: [
        { text: '首页', link: '/' },
        {
          text: '核心机制',
          items: [
            { text: '架构概览', link: '/00-intro/00-architecture-overview' },
            { text: '服务端启动', link: '/01-server-startup/01-startup-overview' },
            { text: '日志存储', link: '/03-log-storage/01-log-overview' },
            { text: '副本管理', link: '/04-replica-management/01-replica-overview' }
          ]
        },
        {
          text: '进阶',
          items: [
            { text: 'Controller', link: '/05-controller/01-krft-overview' },
            { text: '协调器', link: '/06-coordinator/01-coordinator-overview' },
            { text: '事务', link: '/07-transaction/01-transaction-overview' },
            { text: '网络协议', link: '/11-network-protocol/01-protocol-overview' }
          ]
        },
        {
          text: '客户端',
          items: [
            { text: 'Producer', link: '/09-producer/01-producer-overview' },
            { text: 'Consumer', link: '/10-consumer/01-consumer-overview' }
          ]
        },
        { text: 'FAQ', link: '/FAQ' }
      ],

      sidebar: {
        '/00-intro/': sidebarIntro(),
        '/01-server-startup/': sidebarStartup(),
        '/02-request-processing/': sidebarRequest(),
        '/03-log-storage/': sidebarLog(),
        '/04-replica-management/': sidebarReplica(),
        '/05-controller/': sidebarController(),
        '/06-coordinator/': sidebarCoordinator(),
        '/07-transaction/': sidebarTransaction(),
        '/08-other/': sidebarOther(),
        '/09-producer/': sidebarProducer(),
        '/10-consumer/': sidebarConsumer(),
        '/11-network-protocol/': sidebarNetwork()
      },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/hf7751/kafka-learning' }
      ],

      search: {
        provider: 'local',
        options: {
          translations: {
            button: {
              buttonText: '搜索文档',
              buttonAriaLabel: '搜索文档'
            },
            modal: {
              noResultsText: '无法找到相关结果',
              resetButtonTitle: '清除查询条件',
              footer: {
                selectText: '选择',
                navigateText: '切换'
              }
            }
          }
        }
      },

      outline: {
        label: '本页目录',
        level: [2, 3]
      },

      docFooter: {
        prev: '上一页',
        next: '下一页'
      },

      lastUpdated: {
        text: '最后更新于'
      },

      returnToTopLabel: '回到顶部',
      sidebarMenuLabel: '菜单',
      darkModeSwitchLabel: '主题',
      lightModeSwitchTitle: '切换到浅色模式',
      darkModeSwitchTitle: '切换到深色模式'
    }
  })
)

/* ---------- 侧边栏分组定义 ---------- */

function sidebarIntro() {
  return [
    {
      text: '入门篇',
      collapsed: false,
      items: [
        { text: '架构概览', link: '/00-intro/00-architecture-overview' },
        { text: '源码目录结构', link: '/00-intro/01-source-structure' },
        { text: '构建与调试', link: '/00-intro/02-build-debug-setup' },
        { text: '核心概念深度解析', link: '/00-intro/03-core-concepts-deep-dive' }
      ]
    }
  ]
}

function sidebarStartup() {
  return [
    {
      text: '服务端启动流程',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/01-server-startup/' },
        { text: '启动流程概述', link: '/01-server-startup/01-startup-overview' },
        { text: 'KafkaServer 启动详解', link: '/01-server-startup/02-kafkaserver-startup' },
        { text: '启动配置详解', link: '/01-server-startup/03-startup-config' }
      ]
    }
  ]
}

function sidebarRequest() {
  return [
    {
      text: '请求处理机制',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/02-request-processing/' },
        { text: 'SocketServer 网络层', link: '/02-request-processing/01-socketserver' },
        { text: 'KafkaApis 请求处理', link: '/02-request-processing/02-request-handler' }
      ]
    }
  ]
}

function sidebarLog() {
  return [
    {
      text: '日志存储机制',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/03-log-storage/' },
        { text: '日志存储概述', link: '/03-log-storage/01-log-overview' },
        { text: 'LogSegment 结构', link: '/03-log-storage/02-log-segment' },
        { text: '日志索引机制', link: '/03-log-storage/03-log-index' },
        { text: '日志追加流程', link: '/03-log-storage/04-log-append' },
        { text: '日志读取流程', link: '/03-log-storage/05-log-read' },
        { text: '日志清理机制', link: '/03-log-storage/06-log-cleanup' },
        { text: '日志压缩详解', link: '/03-log-storage/07-log-compaction' },
        { text: '日志操作命令', link: '/03-log-storage/08-log-operations' },
        { text: '日志监控指标', link: '/03-log-storage/09-log-monitoring' },
        { text: '故障排查指南', link: '/03-log-storage/10-log-troubleshooting' }
      ]
    }
  ]
}

function sidebarReplica() {
  return [
    {
      text: '副本管理与同步',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/04-replica-management/' },
        { text: '副本管理概述', link: '/04-replica-management/01-replica-overview' },
        { text: '分区 Leader 选举', link: '/04-replica-management/02-partition-leader' },
        { text: '副本同步深度解析', link: '/04-replica-management/03-replica-sync-deep-dive' },
        { text: '副本拉取机制', link: '/04-replica-management/04-replica-fetcher' },
        { text: '副本状态机', link: '/04-replica-management/05-replica-state' },
        { text: '副本同步与 ISR', link: '/04-replica-management/06-replica-sync' },
        { text: '副本操作', link: '/04-replica-management/07-replica-operations' },
        { text: '分区重分配', link: '/04-replica-management/08-reassignment' },
        { text: '监控指标', link: '/04-replica-management/09-replica-monitoring' },
        { text: '故障排查', link: '/04-replica-management/10-replica-troubleshooting' },
        { text: '配置详解', link: '/04-replica-management/11-replica-config' }
      ]
    }
  ]
}

function sidebarController() {
  return [
    {
      text: 'Controller 控制器',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/05-controller/' },
        { text: 'KRaft 架构概述', link: '/05-controller/01-krft-overview' },
        { text: 'ControllerServer 启动', link: '/05-controller/02-startup-flow' },
        { text: 'QuorumController 核心', link: '/05-controller/03-quorum-controller' },
        { text: 'Raft 协议实现', link: '/05-controller/04-raft-implementation' },
        { text: '元数据发布机制', link: '/05-controller/05-metadata-publishing' },
        { text: '高可用与故障处理', link: '/05-controller/06-high-availability' },
        { text: 'Leader 选举详解', link: '/05-controller/07-leader-election' },
        { text: '集群部署指南', link: '/05-controller/08-deployment-guide' },
        { text: '运维操作命令', link: '/05-controller/09-operations' },
        { text: '监控与指标', link: '/05-controller/10-monitoring' },
        { text: '故障排查', link: '/05-controller/11-troubleshooting' },
        { text: '配置参数详解', link: '/05-controller/12-configuration' },
        { text: '性能优化', link: '/05-controller/13-performance-tuning' },
        { text: '调试技巧', link: '/05-controller/14-debugging' },
        { text: '最佳实践', link: '/05-controller/15-best-practices' },
        { text: '安全与权限', link: '/05-controller/16-security' },
        { text: '备份与恢复', link: '/05-controller/17-backup-recovery' },
        { text: 'ZK→KRaft 迁移', link: '/05-controller/18-migration-guide' },
        { text: '常见问题', link: '/05-controller/19-faq' },
        { text: 'KRaft vs ZooKeeper', link: '/05-controller/20-comparison' }
      ]
    }
  ]
}

function sidebarCoordinator() {
  return [
    {
      text: 'GroupCoordinator 协调器',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/06-coordinator/' },
        { text: 'Coordinator 概述', link: '/06-coordinator/01-coordinator-overview' },
        { text: 'Consumer Group 管理', link: '/06-coordinator/02-group-management' },
        { text: 'Rebalance 协议', link: '/06-coordinator/03-rebalance-protocol' },
        { text: '重平衡流程', link: '/06-coordinator/04-rebalance-process' },
        { text: 'Offset 管理', link: '/06-coordinator/05-offset-management' },
        { text: 'Group 状态机', link: '/06-coordinator/06-group-state-machine' },
        { text: '运维操作', link: '/06-coordinator/07-coordinator-operations' },
        { text: 'Rebalance 优化', link: '/06-coordinator/08-rebalance-optimization' },
        { text: '监控指标', link: '/06-coordinator/09-coordinator-monitoring' },
        { text: '故障排查', link: '/06-coordinator/10-coordinator-troubleshooting' },
        { text: '配置详解', link: '/06-coordinator/11-coordinator-config' }
      ]
    }
  ]
}

function sidebarTransaction() {
  return [
    {
      text: '事务机制',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/07-transaction/' },
        { text: '事务概述', link: '/07-transaction/01-transaction-overview' },
        { text: '事务协调器', link: '/07-transaction/02-transaction-coordinator' },
        { text: '事务协议', link: '/07-transaction/03-transaction-protocol' },
        { text: '两阶段提交', link: '/07-transaction/04-two-phase-commit' },
        { text: '事务日志', link: '/07-transaction/05-transaction-log' },
        { text: '幂等性保证', link: '/07-transaction/06-idempotence' },
        { text: '事务操作', link: '/07-transaction/07-transaction-operations' },
        { text: '事务监控', link: '/07-transaction/08-transaction-monitoring' },
        { text: '故障排查', link: '/07-transaction/09-transaction-troubleshooting' },
        { text: '事务配置', link: '/07-transaction/10-transaction-config' },
        { text: '事务模式与最佳实践', link: '/07-transaction/11-transaction-patterns' }
      ]
    }
  ]
}

function sidebarOther() {
  return [
    {
      text: '补充内容',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/08-other/' },
        { text: 'Raft 协议通俗指南', link: '/08-other/raft-protocol-explained' }
      ]
    }
  ]
}

function sidebarProducer() {
  return [
    {
      text: 'Kafka Producer',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/09-producer/' },
        { text: '架构概述', link: '/09-producer/01-producer-overview' },
        { text: 'RecordAccumulator', link: '/09-producer/02-record-accumulator' },
        { text: 'Sender 线程', link: '/09-producer/03-sender-thread' },
        { text: '元数据管理', link: '/09-producer/04-metadata-management' },
        { text: '分区器', link: '/09-producer/05-partitioner' },
        { text: '拦截器', link: '/09-producer/06-interceptors' },
        { text: 'TransactionManager', link: '/09-producer/07-transaction-manager' },
        { text: '配置详解', link: '/09-producer/08-producer-config' },
        { text: '实战指南', link: '/09-producer/09-producer-practical-guide' }
      ]
    }
  ]
}

function sidebarConsumer() {
  return [
    {
      text: 'Kafka Consumer',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/10-consumer/' },
        { text: '架构概述', link: '/10-consumer/01-consumer-overview' },
        { text: 'Fetcher 拉取机制', link: '/10-consumer/02-fetcher-mechanism' },
        { text: 'ConsumerCoordinator', link: '/10-consumer/03-consumer-coordinator' },
        { text: '分区分配策略', link: '/10-consumer/04-partition-assignor' },
        { text: 'Rebalance 重平衡', link: '/10-consumer/05-rebalance-process' },
        { text: 'Offset 管理', link: '/10-consumer/06-offset-management' },
        { text: 'AsyncKafkaConsumer', link: '/10-consumer/07-new-consumer' },
        { text: '配置详解', link: '/10-consumer/08-consumer-config' },
        { text: '实战指南', link: '/10-consumer/09-consumer-practical-guide' }
      ]
    }
  ]
}

function sidebarNetwork() {
  return [
    {
      text: '网络协议',
      collapsed: false,
      items: [
        { text: '章节导览', link: '/11-network-protocol/' },
        { text: '协议概述', link: '/11-network-protocol/01-protocol-overview' },
        { text: '请求响应格式', link: '/11-network-protocol/02-request-response-format' },
        { text: '消息格式演进', link: '/11-network-protocol/03-message-format' },
        { text: '版本协商', link: '/11-network-protocol/04-version-negotiation' },
        { text: '序列化机制', link: '/11-network-protocol/05-serialization' },
        { text: 'NetworkClient', link: '/11-network-protocol/06-network-client' },
        { text: '安全协议', link: '/11-network-protocol/07-security-protocol' }
      ]
    }
  ]
}
