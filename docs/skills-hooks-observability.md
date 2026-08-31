# Skills、Hooks 与可观测性生产边界

本文描述 v3 Runtime 的唯一生产实现。旧 AgentLoop 中的 `SkillRegistry`、`HookManager` 和分散 trace/log 模块不是 v3 权威，也不得作为回退路径。

## Skills：静态 Provider，动态 scoped snapshot，包资源按需加载

`skills.catalog` 在 Manifest 中仍是静态、受审计 Provider，不从任意磁盘加载 JavaScript。实际目录发现发生在每次 admission，接收精确 Workspace 和 `AbortSignal`。built-in、user、workspace Provider 按 `100 < 200 < 300` 合并，同名 Skill 由 Workspace scope 覆盖。每次 snapshot 固定：

- `name`；
- 单行 `description`；
- `layer`；
- 规范化的 `modelInvocable`/`userInvocable`；
- 覆盖 `SKILL.md` 与资源 descriptor 的 package SHA-256 revision；
- catalog digest、`complete`、`fresh/last_good` 来源和缺失名称。

完整且无缺失的观察会原子替换该 Workspace 的 last-good。瞬时 Provider 异常或显式 incomplete 只能复用既有 last-good；首次观察不完整时没有可发布 catalog。完整观察确认配置 Skill 缺失会清除 last-good，并拒绝新 Run。目录变化无需重启 Runtime，下一个 admission 会重新观察。

Admission 只把 model-invocable Skill 的名称、描述、revision、snapshot digest 与观察来源写入受保护 system message，不读取正文。invocation-neutral snapshot 同时保留 user-invocable 语义，但当前 Renderer/Main 尚无对应的人类命令目录。模型必须调用同一 immutable Tool Catalog revision 18 中的 `skill.load(name, revision)`。Admission 公布过的 candidate 按 Workspace/name/revision 在 Runtime 生命周期内保留；Tool 调用及结果沿既有 Effect/continuation 持久链路进入后续 Turn。

本地 Skill package 最多包含 128 个资源：正文最大 128 KiB、单资源最大 1 MiB、整包最大 4 MiB、目录深度最大 8。加载时重新检查 realpath、containment、symlink、metadata、调用策略和完整 package revision；文件或资源被删除、替换、更新，或请求 revision 未被 admission pin 时 fail closed。

`skill.load` 只返回正文与无路径泄露的资源 descriptor。模型只有在正文明确需要某个资源时，才调用 `skill.resource.read(name, revision, relativePath)`；Tool 再次重读并验证同一 package pin、精确相对路径、媒体类型、大小和字节 digest。严格 UTF-8 文本直接返回，其他受限媒体返回 bounded base64。package 中的脚本始终是数据，不会自动执行、注册 Tool 或扩大 Capability。Caller 取消和 Manifest 关闭都会中断 discovery/load/resource 等待并关闭静态 Provider。

`skills.catalog` Public Capability 只表示服务已接线，不再混入某次目录健康结果；配置缺失由 admission 的 `skill_not_found` 明确报告，而不是把 Provider 从 status 隐藏。

## Hooks：类型化生命周期

`hooks.lifecycle` 现在拥有必需的 `agent.hooks.lifecycle` service，而不是只宣告状态。Manifest start 静态注册受审计 Provider；Agent Control 的 Public Projection delivery sink 建立后，Pipeline 只通过 service 绑定 handler set，不再读取 `runtimePolicy.hooks` 或构造具体 Hook 类。缺少 Provider 会使终端 Runtime service bundle 编译失败。

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

多个静态 Provider 按 composition 顺序执行。Admission 最终仍通过既有 attenuation validator 证明没有扩权；inference/tool pre 异常 fail closed，post observer 异常逐 Provider 隔离并 fail open。Manifest 关闭时先反向关闭已绑定 handler set，再反向关闭 Provider；关闭后的 bind/pre 操作拒绝，post observation 不再投递。没有运行期注册、磁盘发现或 Skill script 自动装配。

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

- [Skills subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/skills.md)
- [Tool Skill](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/tool-skill/README.md)
- [Capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/capability-seams.md)
- [Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/agent-lifecycle.md)
