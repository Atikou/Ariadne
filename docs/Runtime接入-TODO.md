# Runtime 接入 TODO

> 当前状态：未开始。本文是未来验收清单，不代表已有实现。

## 0. 启动条件

- [ ] 明确 Runtime 的独立交付边界和负责人。
- [ ] 决定协议版本策略、兼容窗口和错误码规范。
- [ ] 确定 Runtime 数据目录、升级、备份和恢复责任。
- [ ] 确定模型配置和密钥来源；密钥不得进入 Renderer 或桌面状态仓库。

## 1. protocol

- [ ] 在 `packages/protocol` 新建独立 package。
- [ ] 定义版本化请求、响应、流式事件和错误 envelope。
- [ ] 定义权限请求、用户输入请求和取消语义。
- [ ] 定义不含 Base64 的资源 ID 与受控文件引用。
- [ ] 为所有入站消息提供运行时 schema 校验。
- [ ] 建立兼容性、未知字段、版本不匹配和畸形消息测试。
- [ ] 确保协议包不依赖 Electron、React、数据库或 Runtime 内部代码。

## 2. runtime

- [ ] 在 `runtime` 新建独立 package 和可直接由 Node 启动的入口。
- [ ] 使用 Node 子进程 IPC；禁止 `createServer()` 和端口监听。
- [ ] 将 Agent、模型、上下文、记忆、工具、任务和持久化全部放入 Runtime。
- [ ] 建立有限并发、取消、超时和异常隔离。
- [ ] 将大文件解析和 CPU 密集任务放入 `worker_threads`。
- [ ] 将模型 Token 按时间或字符阈值合并后再发送事件。
- [ ] 建立 Runtime 独立单元测试，不启动 Electron。

## 3. app

- [ ] Main 增加单一 Runtime 生命周期控制器，只负责启动、停止、有限重启和异常检测。
- [ ] Main 增加通用、固定、经 schema 校验的协议转发器。
- [ ] Main 建立资源登记表；Renderer 只能拿到资源 ID 和公开元数据。
- [ ] Preload 不暴露 PID、绝对路径、密钥、任意 IPC 或任意方法名。
- [ ] Renderer 只根据真实 Runtime capability 显示已接入功能。
- [ ] 用 protocol 事件替换当前仅用于桌面壳验收的 `MockScenarioStore`；替换前保留现有桌面交互，不把 Mock 当成真实 Runtime 状态。

## 4. 性能与安全验收

- [ ] 应用和 Runtime 均不监听本地端口。
- [ ] IPC payload 不包含 Base64 文件或图片。
- [ ] 流式事件不会逐 Token 刷新 Renderer。
- [ ] Renderer 不直接访问 Runtime、数据库或文件系统。
- [ ] Runtime 崩溃不会拖垮 Electron Main，自动重启次数有上限。
- [ ] 退出应用能完成 Runtime flush 和进程回收。

## 5. 完成定义

只有协议测试、Runtime 独立测试、Electron 进程联调、异常恢复、资源引用、安全边界和生产构建全部通过后，才允许把 `runtime` 和 `packages/protocol` 加回根 workspace，并在 README 中声明“已接入”。
