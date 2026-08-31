# ADR 0034：采用实体组件装配，不采用共享 World ECS

- 状态：Accepted
- 日期：2026-08-31
- 依据：`docs/entity-component-architecture-roadmap.md`

## 决策

Ariadne 使用 Entity–Component Assembly（ECA）组织产品能力：Agent、UI、Speech 分别编译自己的不可变 Component Manifest，Application Profile 选择组件并验证跨实体 capability/contract，Platform Kernel 继续拥有 Electron、Preload、Runtime transport、Credential 与进程生命周期。

组件必须声明稳定 ID、版本、所属实体、required/optional、依赖、消费/提供的 typed service token、配置 schema 与生命周期。图在任何业务 Store、窗口或 Sidecar 启动前完成校验；缺失依赖、重复 owner、循环依赖、未声明服务访问和部分启动失败全部 fail closed。

第一阶段只支持仓库内源码组件和构建期静态 Catalog。组件集合在 bootstrap 后冻结，不扫描用户目录，不运行任意外部 JavaScript，不支持生产热卸载。

## 保留的不变量

- Agent Run、Conversation、Projection、Productivity 等事实继续只有一个事务 Owner；
- Component Kernel 不是 Service Locator，组件只能解析声明过的 service token；
- Agent、UI、Speech 的实现不得跨实体导入，只能通过 Public/Host/Desktop Protocol；
- Renderer 不获得 Credential、文件系统、进程或数据库对象；
- 核心 Loop、Persistence、Command Journal、Projection 与恢复组件为 required；
- schema migration 在组件启动前显式执行，不由 `start()` 隐式修改；
- shutdown 按启动逆序执行，部分启动必须回滚。

## 被替换的错误前提

新增能力不再依靠修改多个中央数组、巨型 Factory、Activity Bar 特判和集中 Router 分支来完成装配。共享 Component Kernel 替换散落在各实体中的重复图校验、依赖解析和生命周期规则；已有正确的领域 Owner、事务与恢复实现不重写成 ECS Store。

## 后果

- 新能力可以由一个或多个实体组件组成 Feature Pack，但 Feature Pack 只关联 ID、版本和验收矩阵；
- `@ariadne/component-contracts` 必须保持无 Runtime、Electron、React 和 Node 平台依赖；
- 现有 Runtime Capability Manifest 迁移到共享 Kernel 后，旧的重复图编译逻辑必须删除；
- 外部插件、签名、权限、隔离和热更新另立安全设计，不在本 ADR 范围内。
