# 源码快照复现契约

## 目标

任意开发者或 CI 都应能从一个 Git commit 的干净检出重建 Ariadne，而不依赖原开发机器的未跟踪文件、全局源码目录、运行数据库或凭据。

当前远端初始基线是 `main` 的 `9d52708e923431368531eeedac41fa066b51b194`。本契约从包含本文的后续提交开始执行，之后的提交必须继续满足它。

## 固定输入

- Node.js `24.16.0`，由 `.nvmrc`、根 `package.json` 和 CI 共同固定；
- Node.js 发行包自带的 npm `11.13.0`；
- 根 `package-lock.json` 和 `packaging/runtime/package-lock.json`；
- Git commit 中的源码、测试、迁移、文档和构建脚本；
- CI action 使用不可变 commit SHA，不使用浮动 tag。

仓库不包含 Provider 凭据、签名证书、运行数据库、日志、Electron smoke artifacts、`node_modules`、`dist` 或 `out`。这些内容必须由环境注入或从固定源码重新生成。

## 干净检出复现

```powershell
git clone https://github.com/Atikou/Ariadne.git
Set-Location Ariadne
git checkout <需要复现的提交>

# 使用 .nvmrc 指定的 Node.js；该版本自带 npm 11.13.0
npm.cmd ci
npm.cmd run verify:reproducible
npm.cmd run test:electron
```

`verify:reproducible` 依次检查源码快照、类型、全量测试、依赖方向、热点边界、Runtime 独立性和发布契约。`test:electron` 另外验证真实 Electron 窗口及 Runtime 强杀恢复；它不由普通静态 CI 代替。

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
