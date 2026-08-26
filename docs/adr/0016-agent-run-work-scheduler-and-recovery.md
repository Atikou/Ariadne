# ADR-0016: Agent Run Work Scheduler and Recovery

- Status: Accepted
- Date: 2026-08-01

## Context

Durable inference and Effect dispatch services correctly persist their
`started` boundary before external I/O. They are use cases, not lifecycle
owners: no production component currently scans active Runs, selects
authorized Effects, establishes restart recovery, and continues a settled
Effect batch.

An in-memory queue or timer cannot be authoritative. A process can exit after
the durable start but before the external result, after the result but before
the next Turn, or while a permission/recovery decision is being resolved.

## Decision

### Active Runs are the durable follow-up work queue

The minimal design adds an `AgentRunWorkScheduler`. It uses the active-run
recovery query and aggregate state as its durable queue; it does not add a
second Effect-intent ledger. One store owner and one scheduler single-flight
operation classify work. Work for one Run is strictly serial. A later bounded
implementation may process different Runs concurrently, but never two Effects
or an Effect and inference for the same Run.

The classifier handles one next action per Run snapshot:

| Durable state | Scheduler action |
| --- | --- |
| authorized Effect | Dispatch the next Effect in committed invocation order |
| started Effect during live owned dispatch | Join the in-flight operation |
| started Effect found at startup | Record a stable uncertain recovery result; never execute again |
| uncertain Effect or recovering Run | Wait for an authorized recovery decision |
| intended Effect | Wait for admission or permission authority; never auto-authorize |
| fully settled causal Effect batch | Register its one continuation Turn and protected input |
| intended follow-up inference Attempt | Delegate to the owner defined by ADR-0017 |
| waiting, waiting_children, or cancelling Run | No external work |
| blocked recovery metadata | Latch an unhealthy state and fail readiness |

Version conflicts caused by a concurrent authoritative Decision commit trigger
a fresh classification. Corruption, missing exact authority, or a crossed
external-I/O boundary without recovery evidence latches a health failure.

### Exact execution authority

Before Effect I/O, the scheduler resolves the complete pinned Tool Catalog
identity from the Run and Effect. The compiler-verified Tool Catalog registry
already implements the exact `AgentEffectExecutor` dispatch port. Name-only,
latest-revision, legacy Registry, or default Tool fallback is prohibited.

Before follow-up inference, startup verifies the protected Turn input, exact
Tool Catalog, and exact model binding. Old active Runs whose referenced
authorities cannot be restored block startup rather than being rebound.

### Recovery of started work

`AgentEffectDispatchService` remains the sole normal Effect dispatcher. It
commits `run.start_effect`, performs one exact execution, and commits
`run.record_effect_result`.

A started Effect discovered before scheduler work begins has an unknown
external outcome. A recovery service records `uncertain` with stable command
and recovery-decision identities. It never calls the executor, even when the
Tool declares an idempotency key. Retry requires an explicit recovery decision
and retains the same committed Effect idempotency identity.

Started follow-up inference is treated the same way through the inference
recovery state machine. A Provider request is never repeated merely because a
process restarted.

### Lifecycle

Startup order is:

1. acquire store owner leases;
2. enumerate every page of active Run and execution-intent recovery;
3. validate Checkpoints, Turn inputs, Effect payloads, Tool Catalogs, model
   bindings, budgets, and causal identities;
4. convert abandoned started follow-up work to explicit uncertain recovery;
5. preflight the initial execution-intent ledger without starting its timer;
6. start the Agent Run work scheduler and reach its recovery fixed point;
7. start the initial execution-intent scheduler;
8. start Conversation handoff production and new admission;
9. establish the Public Projection fixed point before reporting ready.

Shutdown order is:

1. freeze external ingress and admission;
2. stop scheduler timers and reject new wakes;
3. abort and join active inference and Effect I/O while stores remain writable;
4. persist their known cancellation or uncertain outcome;
5. stop the initial execution-intent scheduler;
6. establish the final Conversation handoff and projection fixed points;
7. close Agent and Conversation stores last.

Pending work durably created by a final handoff may remain for the next startup.
No external I/O continues after its owning scheduler has joined.

## Consequences

- Timer cadence and process memory do not determine whether work exists.
- Started external work always becomes explicit recovery, never blind replay.
- Safe production startup now depends on restoring exact historical Tool and
  model authorities.
- Effect execution may remain pending across a clean shutdown and resume from
  the authorized state at the next startup.

## Existing reusable components

- `AgentEffectDispatchService` already supplies the durable pre-I/O fence and
  known/uncertain result transitions.
- `SqliteAgentRunUnitOfWork.listActiveRuns()` already returns paged, verified
  active Run recovery snapshots and protected Effect references.
- `V3AgentEffectDispatchCheckpointFactory` already creates bounded v3 Effect
  checkpoints.
- The immutable Tool Catalog registry already validates and executes one exact
  prepared Tool input by its complete seven-field Tool pin.
- The execution-intent scheduler, handoff producer, shutdown context, stable
  IDs, and health-latch patterns are reusable lifecycle examples.

## Implementation status

- `AgentRunWorkScheduler` performs full-page startup scans, exact authority
  preflight, startup-only started-work recovery, optimistic-conflict rescans,
  dirty-wake fixed points, health latching, and deadline-bounded shutdown.
- `ProductionAgentRunWorkAuthorityVerifier` rejects unavailable historical
  model or Tool authorities before Provider or Tool I/O.
- `AgentStartedWorkRecoveryCoordinator` records stable uncertain Effect or
  inference recovery facts without repeating external I/O.
- Initial inference settlement and Decision resolution wake the same scheduler;
  Effect, continuation, follow-up inference, and deterministic terminalization
  are consumed in one fixed point.
- `ComposedAgentControlRuntime` owns startup, health, and joint scheduler
  shutdown ordering. A disabled pipeline with any active Run fails closed.
- Default application composition supplies the trusted Catalog and makes this
  the production Agent work path. Real Provider, real-window Tool/Decision and
  crash recovery remain acceptance gates.

## Verification

Required tests cover every classifier state, multi-Run fairness, strict
per-Run serialization, version-conflict rescan, crash before and after each
Effect fence, started-to-uncertain startup recovery, no executor call after
restart, exact catalog drift, model-binding drift, wake coalescing, timer
independence, shutdown abort/join, final durable pending work, and readiness
failure on incomplete recovery material.
