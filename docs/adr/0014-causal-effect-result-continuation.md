# ADR-0014: Causal Effect-Result Continuation

- Status: Accepted
- Date: 2026-08-01

## Context

The Effect state machine durably records intention, authorization, external
start, and known or uncertain outcomes. A successful inference can atomically
introduce one or more Effects. After those Effects settle, however, the Run
remains `running`; no durable fact identifies the one next Turn caused by that
exact tool batch.

Creating a Turn merely because all current Effects look terminal is
insufficient. A timer or replay could create the same continuation twice,
combine results from different Directives, reorder a multi-Tool batch, or
continue before one Effect has reached a known terminal state.

## Decision

### A Turn carries an explicit cause

`AgentTurn` intention will contain one exact cause:

```ts
type AgentTurnCause =
  | {
      kind: 'conversation_objective';
      messageId: string;
      messageVersion: number;
      contentDigest: string;
    }
  | {
      kind: 'delegation_objective';
      parentRunId: string;
      delegationId: string;
      objectiveDigest: string;
    }
  | {
      kind: 'effect_results';
      sourceTurnId: string;
      sourceAttemptId: string;
      sourceDirectiveDigest: string;
      effectIds: readonly string[];
      toolCallIds: readonly string[];
    };
```

The first Turn uses `conversation_objective` or `delegation_objective` and
must exactly match the Run binding's objective reference. A follow-up Turn
created from an `invoke_tools` Directive uses `effect_results`.

For an Effect continuation, Core must prove that:

- the source Turn and Attempt belong to the same Run;
- the Attempt succeeded with the exact `sourceDirectiveDigest`;
- the committed Directive is `invoke_tools`;
- `effectIds` and `toolCallIds` exactly match all Directive invocations in
  invocation order;
- every referenced Effect has the exact source origin and is `succeeded`,
  `failed`, or `cancelled`;
- no Turn already has the same source Turn, Attempt, and Directive digest.

An `uncertain` Effect is not terminal and never contributes a result until an
authorized recovery resolution records a known result or cancels the Run.

### Reuse the Turn command with stronger facts

The existing `run.register_turn` command remains the aggregate mutation. It
will require the new cause and an exact Turn Input Snapshot from ADR-0013 in
the same command commit. A separate `next_turn` command name is not required;
the strengthened cause makes the legal transition explicit.

The command ID, Turn ID, Attempt ID, and Provider idempotency key are stable
derivations of the Run and source causal identity. Repeating the coordinator
after a crash replays the same command receipt. Payload drift under an existing
identity fails closed.

### Batch barrier and result construction

One `invoke_tools` Directive creates one result barrier. No next Turn is
registered until every invocation in that Directive has a known terminal
Effect state. Results are loaded from protected Effect payloads and ordered by
the original invocation order, never by completion time or table order.

Succeeded and failed Effect result bodies remain protected. Cancellation uses
the bounded, sanitized terminal reason from the aggregate. Recovery resolutions
use their persisted protected recovery-result artifact. The resulting model
input is committed as the new Turn's protected snapshot.

### Budget and terminal behavior

The aggregate must enforce:

```text
run.turns.length <= run.binding.budget.vector.modelTurns
```

Before registering a continuation, the coordinator also checks the immutable
deadline and exact execution authorities. Exhausted model-turn budget or an
expired deadline produces a deterministic `run.fail` command after all Effects
are settled.

Effect settlement never implies `run.complete`. Only a later committed model
Directive may respond, complete, fail, request a decision, checkpoint, or
introduce another Effect batch.

## Consequences

- Multi-Tool results are delivered exactly once as one causal batch.
- Stable causal identities make restart replay independent of in-memory
  queues and timer timing.
- Generic Turn registration remains reusable, but every production caller
  must now supply a valid cause and protected input artifact.
- `checkpoint` Directives remain a separate nonterminal continuation case and
  are not silently treated as Effect results.

## Existing reusable components

- `AgentEffect.origin` already binds an Engine-derived Effect to a source Turn,
  Attempt, and Directive digest.
- Committed `invoke_tools` Directives already retain exact Effect and
  `toolCallId` identities in invocation order.
- `run.register_turn` already enforces running state, no open inference
  Attempt, and no unsettled Effect.
- The aggregate and `run.register_turn` now enforce the immutable model-turn
  budget.
- Effect result and recovery-resolution payloads already use protected
  persistence.
- Command receipts and stable-ID helpers already provide exact replay.

## Implementation status

- `AgentTurn` and `run.register_turn` carry and validate the exact continuation
  cause.
- `AgentEffectContinuationController` derives one stable continuation command,
  Turn, Attempt, protected input snapshot, and checkpoint from a complete
  terminal Effect batch.
- SQLite validates durable result authority, exact causal prefixes, protected
  payload authentication, and replay before accepting or loading a
  continuation.
- `AgentRunWorkScheduler` owns the fixed point from Effect settlement through
  continuation and follow-up inference; Decision resolution and initial-intent
  settlement wake that same owner.
- Exhausted model-turn budget or deadline produces a stable `run.fail` rather
  than a scheduler health fault.
- Default application composition provides the trusted built-in Catalog and
  wires this production pipeline. Real-window continuation and crash recovery
  remain acceptance gates.

## Verification

Required tests cover one and many Effect invocations, different completion
orders, failed and cancelled results, uncertain recovery, retry attempts,
permission approval, stable replay before and after the Turn commit, duplicate
cause rejection, cross-Directive mixing, result payload drift, model-turn and
deadline exhaustion, and proof that Effect settlement alone never completes a
Run.
