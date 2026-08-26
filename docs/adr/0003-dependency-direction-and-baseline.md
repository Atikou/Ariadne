# ADR-0003：依赖方向门禁与债务基线

- 状态：Accepted
- 日期：2026-07-31

## 背景

决策时的生产 TypeScript 依赖图存在循环。立即要求零循环会阻断渐进重构，而忽略既有循环又会允许债务继续增长。

## 决策

`scripts/check-architecture.mjs` 扫描 `app/src`、`runtime/src` 和所有 `packages/*/src` 下的 TS/TSX 文件。以下语法都形成依赖边：

- 静态值导入与 `import type`；
- 值再导出与类型再导出；
- TypeScript 类型位置的 `import()`；
- 字面量动态 `import()`；
- `import = require()`。

Tarjan SCC 用于识别循环。下面的可机读 baseline 记录接受时已经存在的 SCC、循环边和依赖规则违规。默认门禁拒绝：

- 不属于任一既有 SCC 子集的新循环组件；
- 新增的循环边；
- 新增的依赖规则违规；
- 已删除但尚未从 baseline 清除的旧债务。

当且仅当审查确认变更确实删除了债务时，在同一个变更中刷新 baseline。首次建立基线或刷新已减少的基线都必须显式运行：

```powershell
node scripts/check-architecture.mjs --write-baseline --acknowledge-current-debt
```

普通开发和 CI 只能运行默认检查。不得通过更新 baseline 隐藏回归。

## 目标依赖规则

- Contracts 不依赖 App、Runtime 或 Agent Core。
- Agent Core 只依赖自身 Domain 与 Ports。
- Runtime 不依赖 App；App 不导入 Runtime 或 Agent Core 源码。
- Runtime 新目录遵循 `transport -> ingress -> control -> Agent Core`；Adapter 只实现 Ports；Composition 才能组装两侧。
- Main、Preload、Renderer 和 Shared 不能跨进程目录反向导入。
- Renderer/Preload 只能读取 Public/Desktop Contracts。
- Renderer/Shared 不能直接导入 Node/Electron 平台能力。
- 禁止使用 Contracts 根导出桶，必须选择明确的子契约。

## 债务退出规则

基线只用于单调减少。每次拆环或移除越层依赖后必须在同一个变更中刷新 baseline；因此已经删除的循环边不能在后续提交中悄然恢复。最终目标是 `cycles=[]`、`cyclicEdges=[]`、`ruleViolations=[]`。

## 当前提交基线

以下内容由脚本维护，不手工编辑。

<!-- architecture-baseline:start -->
```json
{
  "schemaVersion": 1,
  "architectureVersion": 2,
  "sourceRoots": [
    "app/src",
    "runtime/src",
    "packages/agent-core/src",
    "packages/protocol/src"
  ],
  "cycles": [],
  "cyclicEdges": [],
  "ruleViolations": []
}
```
<!-- architecture-baseline:end -->
