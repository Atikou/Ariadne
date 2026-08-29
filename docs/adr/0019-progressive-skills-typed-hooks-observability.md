# ADR 0019: Progressive Skills, Typed Hooks, and Isolated Observability

- Status: Accepted
- Date: 2026-08-26

> Skill discovery 的 bootstrap-frozen 部分已由 [ADR-0029](0029-cancellable-scoped-skill-catalog-snapshots.md) 取代；Hook ownership 已由 [ADR-0031](0031-manifest-owned-trusted-hook-provider-lifecycle.md) 补齐。typed event 与 observability 决策仍有效。

## Context

The v3 path injected every enabled Skill body at admission, consumed only a declarative `run.pre` Hook, and had diagnostic DTOs plus an unowned telemetry implementation. Configuration therefore overstated production behavior.

## Decision

1. 当时采用 bootstrap-frozen Skill catalog 贡献 metadata 与 `skill.load`；当前实现改为 ADR-0029 的 scoped snapshot，但正文仍只按精确 revision 经 durable Tool path 加载。
2. Hook events use typed v3 lifecycle names. Pre Hooks may reject, admission may attenuate authority, and post Hooks are observer-only.
3. Hook deliveries use stable hashed identities and expose no business payload.
4. Lifecycle diagnostics are retained in the replayable Public Projection with a 512-entry bound.
5. Telemetry is a Capability Provider service and is advertised only after its allowlisted exporter starts. Exporter failures never control Agent execution.
6. The Capability Manifest is the service locator for bootstrap-frozen Provider services; consumers cannot register or replace services after startup.

## Consequences

Skill 更新由 ADR-0029 的下一次 scoped snapshot 观察，不再要求 Runtime 重启；运行中 pin 仍在 source drift 时 fail closed。Hook Provider 由 Manifest 静态装配和关闭，不能运行任意脚本。Diagnostics 适合产品状态与重放，不是 Prompt 取证通道；外部 Telemetry 仍可选且可移除。
