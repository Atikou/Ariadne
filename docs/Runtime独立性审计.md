# Ariadne Runtime 独立性审计

## 架构结论

Ariadne 是单独维护、单独构建和单独发布的项目。桌面端唯一运行链路为：

```text
Renderer → 最小化 Preload → Electron Main → Node IPC → Ariadne Runtime
```

Runtime 的 Agent、模型、上下文、工具、权限、计划、记忆、调度、SubAgent、存储和沙箱逻辑都属于 Ariadne 自身源码。构建、测试和发布只使用当前 monorepo workspace 与固定打包资产。

## 自动审计

```powershell
npm.cmd run audit:runtime-independence
```

审计会 fail-closed 检查：

- 所有 `file:` 依赖仍位于 Ariadne 项目根内；
- 根级发布脚本不引用项目根之外的相对路径或绝对路径；
- Runtime 不包含入站 HTTP Server、端口监听、`runtime/src/server` 或 `runtime/public`；
- 审计只读取当前 Ariadne 工作区。

机器可读 JSON 直接写到标准输出，`ok=false` 时命令返回非零状态。

## 审计边界

独立性审计只证明生产依赖、根发布脚本和 Runtime 入口满足当前工作区边界，不能替代：

- Protocol、Runtime、App 全量测试和生产构建；
- Electron 真实窗口与 Runtime 子进程冒烟；
- 权限、工具、计划、取消、恢复及数据一致性回归；
- 原生沙箱和应用签名验证；
- Transformers Runtime、真实模型、安装升级及回滚验收。

这些验证仍由 `npm.cmd test`、`npm.cmd run test:electron` 和 `npm.cmd run verify:release` 分层完成。
