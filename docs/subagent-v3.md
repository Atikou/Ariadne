# SubAgent v3 产品闭环

> 状态：已接入默认生产 Composition（2026-08-26）

## 产品边界

SubAgent 不是第二套 Agent Loop，也不是 `runtime/src/subagent` 中旧工作流的包装。模型返回严格的 `delegate_subagent` Directive 后，Agent Control 在一个 SQLite 事务中提交：

- 父 Run 的已完成推理结果与 `waiting_children` 状态；
- 不扩权的 Child Run binding；
- Child Budget grant、allocation 和 Delegation protected objective；
- 可由普通 v3 scheduler 执行的 Child Run 首个 Turn；
- 完整 Event、Outbox、Checkpoint 和恢复材料。

Child Run 随后复用主 Agent 的精确模型、Tool Catalog、权限、Effect、长上下文和 started-work recovery 链路。它到达终态后，终态投影写入 immutable child-terminal fact，父 Run 生成 `child_results` continuation Turn；下一次模型调用拿到受保护的 Child 结果并继续原任务。

```text
Parent inference
  -> delegate_subagent
  -> atomic Parent + Delegation + Budget + Child Run commit
  -> ordinary Child v3 inference/tool/recovery
  -> durable Child terminal observation
  -> protected child_results continuation
  -> Parent inference resumes
  -> terminal Conversation projection
```

## 权威与安全约束

- Raw child prompt/objective 只进入受保护 payload；公开 Run/Event/receipt 只保留 ID 和 digest。
- Child workspace、capabilities、Tool Catalog、model、policy、deadline 和 Budget 不得扩大 Parent 权限。
- Child 首轮不再由 Conversation execution-intent owner 处理，而由 dedicated delegated-inference owner 调度；重启后已开始但未落终态的 Provider 调用进入 uncertain recovery，绝不盲重放。
- Parent 只在 durable child-terminal fact 完整后恢复；Child 输出通过 protected terminal-content resolver 回灌。
- Public Projection 暴露 `parentRunId` 和 `delegationId`，Renderer 把 Child 显示在 Parent 的 SubAgent 状态区，并避免把 Child 误选为 Chat 主 Run。
- Runtime 仅在 Agent admission authority 启用时宣告 `agent.subagents`。

## 当前范围

当前闭环实现一个 production provider：同进程、fresh、one-shot ordinary Child Run。这与 deepseek-harness 的 capability seam、ordinary child session、terminal result 和 durable ownership 思路一致，但保留 Ariadne 的单一 Agent Control/UoW 权威。

参考边界：

- [deepseek-harness Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [deepseek-harness SubAgent capability family](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.md)
- [deepseek-harness capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)

尚未宣告完成：多 Child 批量 Directive、continuable child inbox、fork/ACP/Codex/Claude 等外部 Provider、Child 专用公开取消命令、真实商业模型和真实 Electron SubAgent 场景。旧 `runtime/src/subagent` 仍不是生产入口，应在其引用清零后独立删除，不得作为 fallback。

## 验证

自动化验收覆盖：

- 模型 Directive 到 Parent/Child 原子提交；
- ordinary Child Run 的生产模型执行；
- durable terminal observation 与 Budget release；
- `child_results` protected continuation 和 Parent 最终响应；
- Delegation first-Turn work ownership 与重启 uncertain recovery；
- Public Projection 父子身份。

运行完整门禁：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run test:electron
```
