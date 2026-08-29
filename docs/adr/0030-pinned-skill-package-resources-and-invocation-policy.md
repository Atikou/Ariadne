# ADR-0030: Pinned Skill package resources and invocation policy

- Status: Accepted
- Date: 2026-08-29

## Context

ADR-0029 让 Skill 目录进入可取消、按 Workspace 分层的快照，但 revision 只覆盖 `SKILL.md`，正文旁的 reference、script 和 asset 既不可发现，也不属于 admission pin。直接让 Skill 正文使用 Workspace 文件 Tool 会泄露 built-in/user 目录边界，并使资源变化绕过冻结 revision；把脚本自动注册成可执行 Tool 则会把受信任静态 Provider 退化成任意磁盘代码加载器。

同时，Skill 只有单一“已启用”状态，无法表达模型目录和人类命令目录的独立可见性。固定版 deepseek-harness 使用 `modelInvocable`/`userInvocable` 两个正向布尔值；Ariadne 保留该语义，但继续使用 immutable Tool Catalog、Workspace scope 与 protected Effect result 作为执行权威。

## Decision

- 本地 Skill 是有界 package：`SKILL.md` 加最多 128 个相对资源，正文最大 128 KiB、单资源最大 1 MiB、整包最大 4 MiB、目录深度最大 8。
- package 不跟随 symlink；所有目录和文件都必须通过 realpath containment。资源路径只使用无 `.`/`..`、无反斜杠或控制字符的 POSIX-style 相对路径。
- package revision 覆盖正文 digest 以及排序后的资源路径、媒体类型、字节数和资源 digest。任何资源新增、删除或修改都会产生新 revision；旧 Run 不会在原 pin 下读取新字节。
- frontmatter 的 `disable-model-invocation` 与 `user-invocable` 被规范化为必需的 `modelInvocable`/`userInvocable`。省略时两者均为 `true`。
- invocation-neutral snapshot 保留四种策略组合；模型 admission catalog 只渲染 `modelInvocable` 项，`skill.load` 和 `skill.resource.read` 在 Provider 重读后再次检查 model policy。
- `skill.load` 返回正文和资源 descriptor，但不返回磁盘路径。`skill.resource.read` 只接受 admission 固定的 Workspace/name/package revision 与 `skill.load` 返回的精确相对路径；文本按严格 UTF-8 返回，其他媒体使用 bounded base64。
- package 中的脚本始终是数据。它们不会自动执行、注册 Tool、扩大 Capability 或绕过现有 shell approval/sandbox。
- Tool Catalog 升级到 revision 15，使新增资源读取合同与实际构建闭包一起进入 immutable pin；历史 revision 按 ADR-0027 的持久退休规则处理。

## Consequences

- Skill 可以携带 reference、script 和 asset，而不形成第二条任意文件读取路径。
- 资源变化会使旧 pin fail closed；Provider 的两次重读消除 load 与 resource read 之间的 TOCTOU 漂移。
- Runtime 已保留 user-invocable 目录语义，但 Renderer/Main 尚未提供人类 Skill command catalog；在该 consumer 接入前，不得宣称 user invocation 已形成完整产品入口。
- 可信 Hook handler 的静态注册/关闭已由 [ADR-0031](0031-manifest-owned-trusted-hook-provider-lifecycle.md) 管理，且不通过 Skill package 自动加载。
