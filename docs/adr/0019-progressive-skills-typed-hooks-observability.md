# ADR 0019: Progressive Skills, Typed Hooks, and Isolated Observability

- Status: Accepted
- Date: 2026-08-26

## Context

The v3 path injected every enabled Skill body at admission, consumed only a declarative `run.pre` Hook, and had diagnostic DTOs plus an unowned telemetry implementation. Configuration therefore overstated production behavior.

## Decision

1. A bootstrap-frozen Skill catalog contributes metadata and `skill.load`; bodies are loaded only by exact revision through the durable Tool path.
2. Hook events use typed v3 lifecycle names. Pre Hooks may reject, admission may attenuate authority, and post Hooks are observer-only.
3. Hook deliveries use stable hashed identities and expose no business payload.
4. Lifecycle diagnostics are retained in the replayable Public Projection with a 512-entry bound.
5. Telemetry is a Capability Provider service and is advertised only after its allowlisted exporter starts. Exporter failures never control Agent execution.
6. The Capability Manifest is the service locator for bootstrap-frozen Provider services; consumers cannot register or replace services after startup.

## Consequences

Skill updates require a new Runtime bootstrap snapshot; an active snapshot fails closed on source drift. Hooks cannot run arbitrary scripts. Diagnostics are suitable for product status and replay, not forensic prompt capture. External telemetry remains optional and removable.
