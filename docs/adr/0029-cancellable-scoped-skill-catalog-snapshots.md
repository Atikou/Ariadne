# ADR-0029: Cancellable scoped Skill catalog snapshots

- Status: Accepted
- Date: 2026-08-29

## Context

`skills.catalog` 曾在 Provider 启动时同步扫描所有目录，并把路径、metadata 和 revision 永久冻结在一个 Map 中。`available` 同时表示“service 是否接线”和“启动时是否找到所有配置 Skill”，导致新增/删除/覆盖只能重启 Runtime，瞬时目录错误与权威缺失也无法区分。`skill.load` 只能查询启动快照，不能证明动态目录观察与 admission catalog 属于同一版本。

## Decision

Manifest 仍只装配受审计的静态 Skill Provider，但 discovery 改为每次 admission 的异步、可取消 Workspace snapshot：

- built-in、user、workspace Provider 的优先级固定为 `100 < 200 < 300`，同名 Skill 由最近的 Workspace scope 覆盖；
- snapshot 固定 `workspaceId`、catalog digest、Skill metadata/revision、缺失名称、`complete` 和 `fresh/last_good` 来源；
- 完整且无缺失的观察原子替换该 Workspace 的 last-good；
- Provider 瞬时失败或显式 incomplete 时，只能复用已有 last-good；首次 incomplete 没有可发布 catalog，admission fail closed；
- 完整观察确认配置 Skill 已删除时，立即清除 last-good 并以 `skill_not_found` 拒绝新 Run；
- admission 发布过的 candidate 按 Workspace/name/revision 保留在 Runtime 生命周期内。`skill.load` 只接受该精确 pin，并重新验证 realpath、containment、128 KiB 上限、metadata 和正文 SHA-256；
- caller abort 与 Provider 关闭都会中断 discovery/load 等待；关闭按 Manifest 逆序生命周期传播给所有静态 Provider。

`skills.catalog` Public Capability 表示服务已接线，不再伪装成某次目录健康检查。具体 snapshot 不完整或配置缺失由 admission 明确失败，不能通过隐藏 Capability 掩盖。

## Consequences

- IDE、Git、Shell 或外部进程修改目录后，下一个 admission 会观察新快照，无需 Runtime 重启或第二套 watcher authority。
- 瞬时 Provider 故障不会使已验证的 catalog 突然消失；权威删除也不会被陈旧 last-good 掩盖。
- 运行中的 Run 不会静默加载新 revision；旧源发生漂移时 Tool 明确失败。
- 不开放任意 JavaScript Provider 注册或热重载。Skill 资源包与 model/user invocation policy 已由 [ADR-0030](0030-pinned-skill-package-resources-and-invocation-policy.md) 补齐；人类命令 consumer 和可信 Hook handler 注册仍是独立后续能力。
