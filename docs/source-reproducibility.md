# 源码快照复现契约

## 目标

任意开发者或 CI 都应能从一个 Git commit 的干净检出重建 Ariadne，而不依赖原开发机器的未跟踪文件、全局源码目录、运行数据库或凭据。

每次复现记录实际 Git HEAD、源码内容摘要和工具链；历史初始提交不代表当前远端或当前工作树状态。

## 固定输入

- Node.js `24.16.0`，由 `.nvmrc`、根 `package.json` 和 CI 共同固定；
- 独立固定的 npm `11.13.0`，验证时查询实际执行的 npm CLI；
- 根 `package-lock.json` 和 `packaging/runtime/package-lock.json`；
- Git commit 中的源码、测试、迁移、文档和构建脚本；
- CI action 使用不可变 commit SHA，不使用浮动 tag。

仓库不包含 Provider 凭据、签名证书、运行数据库、日志、Electron smoke artifacts、`node_modules`、`dist` 或 `out`。这些内容必须由环境注入或从固定源码重新生成。

## 干净检出复现

```powershell
git clone https://github.com/Atikou/Ariadne.git
Set-Location Ariadne
git checkout <需要复现的提交>

# 使用 .nvmrc 指定的 Node.js，并在隔离执行中选择固定 npm
npm.cmd exec --yes --package=npm@11.13.0 -- npm ci
npm.cmd exec --yes --package=npm@11.13.0 -- npm run verify:reproducible
npm.cmd exec --yes --package=npm@11.13.0 -- npm run test:electron
```

未提交修改的本地验证可使用忽略目录中的独立源码副本和独立 Git 记录，不清理、提交或重置原工作树。该结果只证明记录的文件集合可复现，不能把原工作树称为干净检出。`npm exec` 可能保留父进程 user-agent，因此检查执行中的 npm CLI 版本，不把该字符串当作工具链证据。

CI 除静态/单元/集成门禁外，还执行真实 Electron、正式/preview Profile 矩阵，以及 Node 22 下独立 Speech 纯逻辑测试。`scripts/write-verification-evidence.mjs` 保存源码 SHA-256、HEAD/dirty、Node/npm/Electron 版本和窗口结果摘要；这些记录不代签未运行的真实模型、硬件或签名发布检查。

`verify:reproducible` 依次检查源码快照、类型、全量测试、依赖方向、热点边界、Runtime 独立性和发布契约。`test:electron` 另外验证真实 Electron 窗口中的运行中 inbox continuation、稳定 command receipt/权威对账及五处 Runtime 强杀恢复；每一处都必须由外层验证器确认目标进程已经退出并写入本次运行的确认标记，Renderer 才能继续验证恢复结果。随后同一隔离 userData 会经历 Renderer reload 和第二次完整桌面进程启动；未结算回执必须以相同 commandId/inputId 恢复为 `reconcile`，目标 inputId 必须仍不在 Public Projection，且只能由显式结算清空。artifact 中的 `inboxContinuationCompleted`、`agentInputDeliveryRecovered`、`rendererReloadDeliveryRecovered`、`userQuestionRuntimeRecoveryCompleted`、`runtimeBoundaryKillsAcknowledged` 和其余三项恢复语义必须同时为 `true`，`desktop-restart-delivery.json` 也必须 `passed=true`。因此低层 API 直写、最终状态自然完成、启动期自动重放、重复 inbox input 或未真正强杀都不能伪装成通过。它不由普通静态 CI 代替。

## `verify:source-snapshot` 的失败条件

- Node/npm 与固定版本不一致；
- Git 检出不干净或存在未跟踪源码；
- Git 跟踪了被 `.gitignore` 排除的文件；
- Git 跟踪了生成目录、运行数据库、日志、私钥文件或 `.env`；
- 源码包含当前开发机的绝对项目路径；
- `file:` 依赖越过仓库边界或目标缺失；
- lockfile、workspace 或工具链声明不一致；
- CI action 使用浮动 tag，或 CI 绕过完整 Architecture Gate。

## 明确边界

这是源码和产品行为的可复现契约，不承诺正式安装包逐字节一致。Windows runner 镜像、代码签名时间戳、远程 Provider 输出和原生工具链仍属于外部输入；正式发布继续由签名、packaged Runtime 和安装器门禁验证。
