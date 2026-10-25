# ADR 0038：桌面聊天草稿与原始输入发送身份

状态：Accepted（2026-10-06；T05 完成，整体整改及中文输入法验收仍另行执行）。

## 归属与保存

窗口 RendererCompositionRoot 拥有一个 ChatDraftStore。编辑归属为 workspaceId 加 sessionId，或 workspaceId 加独立新草稿 UUID；新建操作不会覆盖另一个未发送草稿。编辑修订、输入代次和图片删除序号绑定异步结果。Main ChatDraftRepository 是唯一桌面草稿持久化所有者；严格 IPC 接受逻辑身份和预期存储修订，不能接受 Renderer 指定的文件路径。

当前格式 ariadne-chat-drafts.v1 使用同一原子文件分别保存密封元数据和密封附件正文。Cipher 由 Main 的 ElectronSafeStorageCipher 提供。附件 UUID 必须属于该草稿并被当前编辑或恢复快照引用；枚举只返回引用，显式正文读取再次核对所有权。最多 64 个草稿、每个 16 个恢复快照、附件正文合计 16 MiB，单条消息仍遵守 Protocol 的四张图片／2 MiB 限制。一批保存可覆盖多代未保存引用；其数量按编辑和恢复快照总数有界。坏文件或不可解密文件保持原样，相应存储不可用；不能回退到明文或自动清空。

## 编辑与提交

提交 A 是不可变的快照。先安全保存 A，再让发送所有者派发；输入框可继续编辑 B。确认失败只恢复到精确且未编辑的下一修订，否则保留独立可恢复 A。未知结果保留核对态，不自动恢复为新发送。创建新会话后，Main 在一个原子保存中迁移草稿和附件归属；迁移期间输入及迟到回调继续指向原编辑所有者。切换到 B 的用户选择不能被 A 的回执改变。

ChatDraftDelivery 只协调编辑快照和现有消息／Inbox 发送所有者。它没有命令执行队列，也不从草稿正文重建重试命令。图片正文只在私有 UI 中按引用加载，不进入公共 Projection 或诊断日志；语音开始时绑定编辑所有者与代次，后续人工输入不会被迟到语音替换。

新会话的受保护选择回调在 Main 原子迁移安全保存之后、编辑快照通知 React 之前执行。否则自动生成下一份新草稿会被误判为用户主动切换。RuntimeUiState 的等待展示按原消息和编辑所有者有界保存；已有会话或不同新草稿 UUID 的展示彼此独立。它只是私有窗口展示，不承担业务重放。私有图片正文读取失败提供明确提示、重试与移除，不清空引用。

## Windows 密钥落盘依赖

Electron 43.1.1 的同步 safeStorage 使用 Chromium profile key；业务密文写入完成并不证明首次启动的受保护 profile key 已持久化。Main 初始化唯一 Cipher 时等待 sessionData/Local State 中有界、DPAPI 包装的 os_crypt.encrypted_key 实际存在，并同步该文件，然后才允许依赖仓库确认加密写入。Main 不创建、替换、解密或记录该 key；超时或不可用保持失败。OAuth 回调也等待同一应用启动。依据为 [Electron 同步 safeStorage](https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/api/electron_api_safe_storage.cc)、[profile Local State 所有者](https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/browser_process_impl.cc) 和 [Chromium 147 Windows 密钥保存](https://raw.githubusercontent.com/chromium/chromium/147.0.7727.55/components/os_crypt/sync/os_crypt_win.cc)。同机备份恢复需保留对应 profile 密钥依赖；不能只复制业务密文。

## 唯一发送出站仓库

原 Main Agent 输入出站仓库现为 InputDeliveryOutbox，扩展承载 agent.inbox.enqueue、conversation.session.create 和 conversation.message.accept。保留已安装当前格式的 agent-input-delivery-outbox.json 文件身份与 Schema 1；这不是退役格式导入。新会话的创建与消息接受原始命令必须整批安全保存，才允许任何派发；commandId、完整规范命令与可选 draftSubmissionId 不可漂移。Main 本身不派发。

关联草稿的命令信封，在对应成功或失败草稿更新安全保存后才能结算。窗口重建的核对读原信封、使用原 commandId，结果仍由 Core 命令 Journal 所有。公开 Projection 缺页不证明未发送或失败。只有受信 Main 完成排队写入后列出的发送源为空，且草稿从未记录任何命令引用，才可依据“原子 stage-before-dispatch”证明崩溃发生在发送之前；有引用但信封缺失保持待核对。

物理写入失败锁定出站存储，防止未知磁盘状态被旧内存覆盖；普通身份拒绝不污染后续写队列。现有有效格式的积压可继续读取和结算，新写入受总密文预算约束。不可用的可选发送存储不阻止 Main 或其它独立能力启动。

窗口协调器订阅现有 Run 发送回执，正向接受或拒绝才触发对应草稿安全结算；它不扫描缺页来判失败。同一回执的未变化证据不会反复触发失败结算。关联回执保留展示与关闭，只移除重复恢复入口；关闭前等待安全结算，失败保留回执。两仓库在临时文件写入 flush 后原子 rename；不能将未经持久化 ACK 的键入视为已保护。

## 退出与验收

Main 退出先通过现有受信主窗口等待 drafts.flushAndClose，之后才移除 IPC 和销毁窗口。失败或超时保留窗口并恢复编辑。没有扩大 popout 的既有权限。强杀时只能恢复已安全保存的内容，不承诺尚未到达持久化 ACK 的键入。

当前验证：App 89 文件／401 测试、全部类型／App 构建与架构边界通过。artifacts/todo-remediation/electron-t05-final-physical-reconcile 证明真实 Core 先接受原图片命令，Sky 实际输入 A/B、Renderer 重载后实际点击原发送核对，重放已提交 Journal，安全结算与物理 Main 强杀重启恢复 B/图片。图片／初始提交仍为程序夹具，物理初始发送按钮、中文输入法组合事件及真实 Provider 不在此结论内。electron-t05-known-receipts-full 完整正常 Electron 通过（本地 HTTPS 夹具 70/66/4、五次 Runtime 强杀、Main 重启、Renderer 无记录错误）。t05-chat-drafts-scoped-ui.log 覆盖图片失败重试、跨会话隔离和明确恢复 B+A；整套 UI 的 Agent 状态窄面板失败仍保留至 T09A。所有失败源和日志保留。达到保留预算拒绝新保存并保留窗口内容，不自动驱逐用户草稿。
