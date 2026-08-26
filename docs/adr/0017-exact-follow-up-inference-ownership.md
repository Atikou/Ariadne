# ADR-0017: Exact Follow-up Inference Ownership

- Status: Accepted
- Date: 2026-08-01

## Context

The durable execution-intent pipeline owns the first inference of a newly
admitted Run. Its dispatcher deliberately proves that the Run contains exactly
one Turn and one intended Attempt matching the Conversation handoff intent.
That contract prevents duplicate or mismatched first execution.

A continuation Turn registered after Effect results does not have a
Conversation handoff execution intent. Letting the existing first-turn
dispatcher accept it would weaken the proof it currently provides. Letting a
general active-run scanner dispatch every intended Attempt would race the
first-turn intent owner.

## Decision

### Preserve the first-turn owner

The existing Conversation execution-intent scheduler and first-turn dispatch
controller remain the only owners of a Turn whose cause is
`conversation_objective` and whose intention was admitted with the Run. Their
exact Run, Message, Turn, Attempt, command, and ledger receipt checks are not
relaxed. A `delegation_objective` first Turn requires its own child-admission
owner; it is not claimed by either the Conversation or Effect follow-up owner.

The Agent Run work scheduler must ignore such an intended Attempt. A pending or
crossed first-turn intent is classified exclusively through the durable
execution-intent ledger.

### Add one follow-up owner

A new `AgentFollowUpInferenceScheduler` owns only an intended Attempt whose
Turn has `cause.kind === 'effect_results'`. It verifies:

- the Turn input snapshot and digest;
- the complete causal Effect batch from ADR-0014;
- the exact immutable Run model, Tool Catalog, policy, capability, workspace,
  budget, and deadline bindings;
- that no other open Attempt or started Effect exists;
- that the Attempt is the one initial Attempt of that continuation Turn.

It then calls the existing `AgentInferenceDispatchService`, which commits
`run.start_inference_attempt` before Provider I/O and atomically applies the
resulting Directive. It never invokes the Engine or model gateway directly.

The follow-up scheduler uses a stable dispatch command identity derived from
the Run, Turn, Attempt, input digest, and causal Directive digest. A committed
started Attempt discovered at startup becomes explicit uncertain-inference
recovery; it is not sent again.

### Wake and fixed-point ownership

Effect-batch continuation commits wake the follow-up scheduler only after the
Turn and protected input are durable. A follow-up inference result that creates
authorized Effects wakes the Agent Run work scheduler. Timer ticks only wake
the same single-flight operations and never own state.

Each scheduler ignores work owned by the other:

```text
conversation_objective Turn
  -> durable execution-intent owner

effect_results Turn
  -> follow-up inference owner
```

Unknown or missing causes fail closed. There is no fallback from one owner to
the other.

### Future unification

A later ADR may generalize the execution-intent ledger to carry exact
`turnId + attemptId + inputDigest + cause` for every inference. Until that
schema and atomic continuation-intent commit exist, the first-turn ledger and
follow-up scheduler remain separate. Production code must not partially
generalize the current first-turn controller.

## Consequences

- Initial handoff exactly-once guarantees remain intact.
- Follow-up inference gains restart-safe ownership without stealing pending
  first-turn work.
- Composition has two explicit inference producers and must start, monitor,
  wake, and stop both in the order defined by ADR-0016.
- A malformed Turn cause cannot be made runnable by scheduler fallback.

## Existing reusable components

- The initial execution-intent ledger and scheduler already provide durable
  pending/dispatching/dispatched/settled fences.
- The first-turn controller already binds one admitted Run, Turn, and Attempt.
- `AgentInferenceDispatchService` already owns the durable inference start,
  strict Engine call, Directive planning, result commit, and uncertain outcome.
- The production Engine adapter and exact model gateway already prohibit
  routing and Provider fallback.

## Implementation status

- `effect_results` Turns and protected cumulative follow-up input snapshots are
  committed with exact source identities.
- `AgentRunWorkClassifier` keeps conversation/delegation first Turns disjoint
  from follow-up Turns and exposes only the latest owned Attempt.
- `AgentFollowUpInferenceDispatchController` dispatches only the initial
  Attempt of an exact causal follow-up Turn through
  `AgentInferenceDispatchService`.
- `AgentStartedWorkRecoveryCoordinator` converts an abandoned started follow-up
  Attempt to explicit uncertainty without a second Provider call.
- Production input reconstruction accepts exact protected follow-up snapshots,
  and composition owns wake, health, startup, and shutdown through
  `AgentRunWorkScheduler`.
- Default application composition supplies the trusted Catalog and production
  owner. Real Provider, real-window continuation and crash recovery remain
  acceptance gates.

## Verification

Required tests prove that first-turn and follow-up owners are disjoint, neither
can steal the other's work, exact command replay survives every crash boundary,
started follow-up inference enters recovery without a second Provider request,
catalog/model/input/cause drift fails before I/O, Effect-producing follow-up
results wake only the Agent Run work scheduler, terminal Directives stop the
loop, and lifecycle health fails closed when either inference owner is absent.
