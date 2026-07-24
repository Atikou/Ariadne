# 项目结构

```text
Ariadne/
├─ app/
│  ├─ src/main/runtime/       # Runtime 配置与唯一生命周期控制器
│  ├─ src/main/smoke/         # 真实 Electron 冒烟验证
│  ├─ src/main/windows/       # 主窗口、Popout 白名单与无端口 Renderer 源
│  ├─ src/main/               # 托盘、终端、文件等桌面能力
│  ├─ src/preload/            # 固定、类型化的 Renderer 桥
│  ├─ src/renderer/public/    # Dockview 独立窗口的最小同源文档
│  ├─ src/renderer/           # React + Dockview UI 和 RuntimeStore
│  ├─ src/shared/             # App 内部桌面 IPC 契约
│  └─ tests/                  # App 边界、UI 与 Supervisor 测试
├─ packages/protocol/
│  ├─ src/public.ts           # Renderer 安全的公开协议
│  ├─ src/host.ts             # Main ↔ Runtime 私有进程协议
│  ├─ src/common.ts           # 共享基础 schema
│  └─ tests/                  # 版本、尺寸、严格校验与安全测试
├─ runtime/
│  ├─ src/application/        # RuntimeFacade 与运行上下文
│  ├─ src/transport/          # Node IPC Runtime 宿主
│  ├─ src/entry/              # 子进程入口
│  ├─ src/*                   # Ariadne 自有的 Agent 核心能力
│  ├─ native/                 # Windows 原生沙箱与烟雾工程
│  ├─ config/                 # 配置模板
│  ├─ scripts/                # 模型运行时和沙箱发布脚本
│  └─ tests/                  # 独立 Runtime 集成与边界测试
├─ scripts/electron-smoke.ps1 # 真实窗口联调入口
├─ artifacts/                 # 验证输出，不是运行时数据目录
└─ docs/
```

根 `package.json` 将 `app`、`packages/protocol` 和 `runtime` 注册为 npm workspaces，构建顺序固定为 Protocol → Runtime → App。

## 依赖方向

```text
app ────────┐
            ├──> packages/protocol
runtime ────┘

app -X-> runtime/src
runtime -X-> app/src
Renderer -X-> Node/Electron/数据库/任意传输
```

Dockview Popout 是桌面壳的按需窗口能力，不是第二个 App/Renderer 实例：模块 DOM 和服务仍由主 Renderer 管理，Main 只负责创建经过白名单校验、无脚本且无 Preload 的原生承载窗口；Popout WebContents 不在 IPC 授权集合中。

`runtime/native` 只保存 Ariadne 原生沙箱实现；Runtime 不包含第二套 DesktopHost、入站 HTTP Server、网页测试台、运行状态、模型权重或 `.env`。
