# ADR-0001：Ariadne 拥有独立 Agent Core

- 状态：Accepted
- 日期：2026-07-31

## 背景

现有 Runtime 将 Agent 推理、编排、工具执行、权限、计划、恢复和 UI 投影分散在多个目录与服务中。目录命名无法阻止反向依赖，导致局部修改会穿透多个状态与生命周期边界。

## 决策

Ariadne 的 Agent Core 是本仓库的一等产品模块，由 `packages/agent-core` 承载：

- Domain 定义 Run、Plan、Decision、Effect、Policy 与 Delegation。
- Application 定义命令、Engine、Recovery 与 Ports。
- Agent Engine 只产生 Directive，不执行外部副作用。
- Runtime 通过 Adapter 实现 Ports，并由 Composition Root 完成组装。
- App 和 Renderer 不导入 Agent Core 或 Runtime 源码，只使用版本化 Contracts。

## 后果

- Agent 领域模型可以脱离 Electron、Node、SQLite 和具体 Provider 测试。
- Runtime 的基础设施替换不会改变 Agent 状态机。
- 迁移需要建立新的 package 和单写路径；不能继续把旧 Facade 当作新应用层。
- CI 必须同时检查值导入和类型导入，防止通过 `import type` 恢复反向依赖。
