# Ariadne Runtime 独立性审计

## 架构结论

Ariadne 是单独维护、单独构建和单独发布的项目。桌面端唯一运行链路为：

```text
Renderer → 最小化 Preload → Electron Main → Node IPC → Ariadne Runtime
```

Runtime 的 Agent、模型、上下文、工具、权限、计划、记忆、调度、SubAgent、存储和沙箱逻辑都属于 Ariadne 自身源码。构建、测试和发布不得读取其他源码仓库，也不得调用其他项目的测试命令。

## 自动审计

```powershell
npm.cmd run audit:runtime-independence
```

审计会 fail-closed 检查：

- 生产源码和打包资源中不存在旧项目品牌或硬编码外部源码路径；
- 根级发布脚本不调用外部项目的审计或测试；
- 所有 `file:` 依赖仍位于 Ariadne 项目根内；
- Runtime 不包含入站 HTTP Server、端口监听、`runtime/src/server` 或 `runtime/public`；
- Electron Main 仍通过 Node IPC 唯一拥有 Runtime 子进程。

机器可读 JSON 直接写到标准输出，`ok=false` 时命令返回非零状态。

## 审计边界

独立性审计只证明项目没有外部源码或运行时耦合，不能替代：

- Protocol、Runtime、App 全量测试和生产构建；
- Electron 真实窗口与 Runtime 子进程冒烟；
- 权限、工具、计划、取消、恢复及数据一致性回归；
- 原生沙箱和应用签名验证；
- Transformers Runtime、真实模型、安装升级及回滚验收。

这些验证仍由 `npm.cmd test`、`npm.cmd run test:electron` 和 `npm.cmd run verify:release` 分层完成。
