# Ariadne 可选语音模块

## 架构结论

`speech-runtime/` 是 Ariadne 仓库中的一个可选模块，但不是 Ariadne 核心运行时的一部分。
它必须能够被独立开发、测试、升级、替换和删除；无论模块未安装、被禁用、协议不兼容、
启动失败或运行中崩溃，Ariadne 的文字对话、Agent、工具、模型、历史记录和桌面启动流程都必须继续可用。

语音模块采用独立 Sidecar 进程，而不是把 TTS/STT 引擎、原生音频库或模型权重编译进
`app`、`runtime` 或 `packages/agent-core`。Ariadne 只依赖一个稳定、版本化的可选语音契约，
不依赖任何具体语音项目。

## 模块能力

- 语音活动检测（VAD）。
- 语音转文字（STT），包括临时转写和最终转写。
- 文字转语音（TTS），包括流式播放、取消和用户打断。
- 音频格式标准化、模型加载、资源释放和语音任务生命周期。

以上能力必须通过运行时能力发现声明。没有语音模块时，能力状态为 `unavailable`，
不能被解释成 Ariadne 启动失败或 Agent 执行失败。

## 依赖方向

```text
Renderer
   |
   v
Electron Main Speech Gateway
   |
   +----> UnavailableSpeechAdapter（模块不存在时）
   |
   +----> Versioned Speech Protocol ----> speech-runtime Sidecar
                                             |
                                             +----> VAD/STT/TTS Engine Adapter
```

硬性依赖规则：

- `speech-runtime` 可以依赖 Ariadne 提供的语音契约，Ariadne 核心不能导入
  `speech-runtime` 的源码、引擎 SDK、原生音频插件或模型文件。
- Renderer 不能直接连接语音进程，也不能持有语音模型、设备句柄或 Sidecar 路径。
- Electron Main 负责权限、设备选择、进程启停、协议握手、超时和能力状态。
- Speech Sidecar 只负责音频处理和推理，不拥有 Conversation、Message、Agent Run、
  Permission、Plan 或模型路由等业务状态。
- Agent Runtime 只消费校验后的转写文本或提交 TTS 请求；语音失败不能改变 Agent Run 的结果。
- Speech Sidecar 不读取 Ariadne 数据库，不共享可写 Store，不开放 HTTP 端口。
- 引擎必须位于 Adapter 后方，替换 `sherpa-onnx`、`whisper.cpp`、Kokoro 或 CosyVoice
  时不得修改 Ariadne 核心业务代码。

## 可拔除设计

Ariadne 必须始终提供一个无外部依赖的 `UnavailableSpeechAdapter`。启动时先发现模块，
只有在可执行文件存在、协议版本兼容且健康检查通过后，才把语音能力标记为可用。

不同状态的行为固定如下：

| 状态 | Ariadne 行为 |
|---|---|
| 模块未安装或目录被删除 | 正常启动；隐藏或禁用语音入口；保留文字输入 |
| 用户禁用模块 | 不启动 Sidecar；其他功能不受影响 |
| 协议版本不兼容 | 拒绝连接并记录诊断；回退到 `UnavailableSpeechAdapter` |
| Sidecar 启动失败或崩溃 | 只终止当前语音任务；Agent 与文字会话继续运行 |
| STT 失败 | 保留当前会话和输入框，允许用户改用键盘输入 |
| TTS 失败或被打断 | 停止播放，但已经生成的文字答复保持有效 |
| 引擎或模型被替换 | 只修改 Speech Adapter、配置和语音模块测试 |

## 状态与数据所有权

Speech Sidecar 只允许持有可丢弃的运行时状态：音频缓冲、设备流、VAD 状态、模型实例、
转写片段和合成任务。权威消息、最终答复、会话历史、Agent 状态与权限决定仍由 Ariadne
原有 Owner 管理。

最终 STT 文本必须经过契约校验后，作为普通用户输入进入现有会话命令入口；不能由语音模块
直接写数据库。TTS 只能读取需要朗读的文字副本，不能修改或删除原始消息。

## 独立构建与发布

- 本目录拥有自己的依赖、构建、测试和引擎 Adapter，不污染根工作区的核心依赖图。
- 核心开发、类型检查、测试和打包默认不要求下载语音模型。
- 语音二进制与模型作为可选发布资产，通过清单、校验和及独立版本管理。
- 引擎代码许可证与模型权重许可证分别审计；未通过审计的模型不能进入发布包。
- Ariadne 核心测试使用 Fake/Unavailable Adapter；真实麦克风、扬声器和模型验证只在语音模块测试中执行。

## 删除模块的验收条件

完全删除 `speech-runtime/`、语音二进制、模型资产和模块注册后，必须满足：

1. Ariadne 能正常安装和启动。
2. 文字对话、Agent、工具、模型选择、会话恢复和历史记录可正常使用。
3. 核心构建、类型检查和测试不依赖语音 SDK、原生库或模型文件。
4. UI 不出现失效按钮、无限加载或重复错误通知。
5. Runtime 不因缺少语音模块进入 degraded、failed 或恢复循环。
6. 用户数据不需要迁移或清理，因为语音模块不拥有核心业务数据。

## 当前状态

已实现版本 1 的长度前缀标准输入输出协议、Electron Main `SpeechGateway`、缺失模块降级、
sherpa-onnx Node Sidecar、Streaming Zipformer/VAD/KWS 适配器、分句 TTS、语音包事务和 E 盘安装脚本。
本目录仍不属于根 npm workspace。模型权重必须在许可证审计后独立安装；仓库与核心构建不下载模型。

本地安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\speech-runtime\scripts\install-runtime.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\speech-runtime\scripts\install-model-assets.ps1 -AcceptModelLicenses
```

安装完成但未放置模型时，Sidecar 能完成握手并报告 `unavailable/degraded`，Ariadne 其他能力保持正常。
