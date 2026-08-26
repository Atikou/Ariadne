# Skills、Hooks 与可观测性生产边界

本文描述 v3 Runtime 的唯一生产实现。旧 AgentLoop 中的 `SkillRegistry`、`HookManager` 和分散 trace/log 模块不是 v3 权威，也不得作为回退路径。

## Skills：目录先行，正文按需加载

`skills.catalog` Provider 在 bootstrap 时按 `built_in < user < workspace` 的优先级发现启用 Skill，并冻结：

- `name`；
- 单行 `description`；
- `layer`；
- 完整 `SKILL.md` 的 SHA-256 revision；
- 受根目录 containment 约束的真实文件路径。

Admission 只把名称、描述和 revision 写入受保护 system message，不读取正文。模型必须调用同一 immutable Tool Catalog 中的 `skill.load(name, revision)`。Tool 调用及结果沿既有 Effect/continuation 持久链路进入后续 Turn。

加载时重新检查文件存在性、realpath、128 KiB 上限和 SHA-256。文件被删除、替换、更新或请求 revision 不匹配时 fail closed。`SKILL.md` 旁的脚本不会被发现或执行。配置了不存在的 Skill 时 Runtime 不宣告 `skills.catalog`，且 Run admission 在写入前失败。

## Hooks：类型化生命周期

生产 Hook 事件固定为：

```text
run.admission.pre
inference.dispatch.pre/post
tool.dispatch.pre/post
turn.commit.post
run.terminal.post
runtime.stop
```

只有 `.pre` 事件可以拒绝；只有 `run.admission.pre` 可以收窄 Capability、Budget deadline 和写/壳预算。所有 `.post` 事件都是 observer，不能改变 Agent 状态。`inference.dispatch.pre` 位于 Provider 准备/I/O 之前，`tool.dispatch.pre` 位于 Tool admission，post/commit 事件只在持久提交后发出。

每次投递 identity 由 Hook id/version、typed event 和稳定领域 event id 哈希得到。observer 只收到事件名、结果、时间和哈希 identity，不收到 Prompt、消息正文、Tool 输入输出、路径、credential 或异常对象。observer 同步/异步失败均 fail open。

## 可观测性：独立、脱敏、可重放

`agent.observability` Provider 拥有诊断服务；Agent Control 仅向它发送无业务载荷的生命周期记录。记录作为 `diagnostics` change 持久写入 Public Projection，并通过已有 cursor/digest 协议重放给 Renderer。

- 同一 delivery identity 重放时去重；
- 最多保留 512 条 Agent lifecycle diagnostics，超限时在同一 commit 删除最旧记录；
- public message 由固定模板生成，不复制内部输入；
- diagnostics 不拥有恢复、调度、权限或 Tool authority；
- 写入或 exporter 失败不会回写 Agent 状态。

当 telemetry policy 启用且 allowlisted HTTPS trace/metric exporter 成功构造后，Manifest 才输出 `telemetry.export`。否则只保留 `observability.diagnostics`；OTLP shutdown/exporter 错误被隔离。

## 删除与演进规则

删除 Skills、Hooks 或 observability 任一能力时，必须同时移除其 Provider、service、公开 capability、Tool contribution、Main admission grant、测试和本文。禁止保留配置存在但生产 Consumer 不存在的虚假 status。

设计参考 DeepSeek Harness 的 Skill provider/catalog/tool consumer 分层和 Agent lifecycle listener，但保留 Ariadne 的 immutable Run binding、durable Effect、Public Projection 与 fail-closed authority。

参考源码：

- [Skills subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)
- [Tool Skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md)
- [Capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)
- [Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)
