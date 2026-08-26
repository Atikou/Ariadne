# ADR-0013: Protected Turn Input Execution Snapshot

- Status: Accepted
- Date: 2026-08-01
- If accepted, supersedes ADR-0008 only where it prohibits protected message
  content in the Agent control store. Conversation ownership and handoff
  decisions in ADR-0008 remain unchanged.

## Context

An Agent Turn currently retains an input digest and bounded summary, but not
the exact model input that produced those values. The production input reader
can reconstruct the first user message from Conversation Authority. It cannot
reconstruct a later Turn containing a committed Assistant tool Directive and
the corresponding Effect results.

Re-reading current Conversation state is not an exact recovery mechanism. A
Run must continue from the immutable message version admitted into that Run,
and a later Turn must use the exact protected result values and Tool Catalog
snapshot that were bound to it. At the same time, copying execution material
must not create a second Conversation authority.

## Decision

### One protected snapshot per Turn

Every admitted or registered Turn will atomically persist one versioned,
data-only `AgentTurnInputSnapshotV1` with the command that introduces it:

```ts
interface AgentTurnInputSnapshotV1 {
  format: 'ariadne.agent-turn-input';
  schemaVersion: 1;
  runId: string;
  turnId: string;
  cause: AgentTurnCause;
  authorityRef:
    | {
        kind: 'conversation_message';
        sessionId: string;
        workspaceId: string;
        messageId: string;
        messageVersion: number;
        contentDigest: string;
      }
    | {
        kind: 'parent_delegation';
        parentRunId: string;
        delegationId: string;
        objectiveDigest: string;
      };
  messages: readonly AgentTurnInputMessage[];
  availableTools: readonly AgentAvailableTool[];
}
```

The snapshot is the immutable execution input admitted for one Turn. Its
`messages` and `availableTools` must reproduce the Turn's existing
`inputDigest` and `inputSummary`. Its cause and authority reference must equal
the facts committed in the Turn/Run aggregate. Pinned Tool identities must
equal the immutable Run binding and exact Tool Catalog snapshot. The authority
union is required because a Child Run may be admitted from a protected parent
Delegation rather than a Conversation message.

`run.admit` and `run.register_turn` must each commit exactly one matching Turn
input payload. A command that introduces a Turn without its snapshot, or a
snapshot without a Turn, is rejected before the first write.

### Conversation remains the sole Conversation Authority

Conversation Authority remains the only owner of Sessions, Message versions,
editing, deletion, ordering, and user-visible conversation history. It is read
at admission to verify the exact message version and content digest. The Agent
snapshot freezes that admitted execution material; it does not acquire
Conversation semantics.

The snapshot must never be used to:

- reconstruct, repair, edit, or repopulate Conversation records;
- answer Conversation queries or render chat history;
- infer a missing Conversation-to-Run handoff;
- bypass Conversation deletion or retention coordination;
- publish raw input through Agent Events, Outbox, Public Projection, or logs.

Assistant results become Conversation facts only through the authoritative
Agent-result projection workflow. A Turn input snapshot cannot write them
back.

### Protected persistence and retention

Persistence will add `AgentTurnInputPayloadCommit`, reference, and reader
ports, plus an `agent_v3_turn_inputs` table keyed by `run_id + turn_id`. The
payload is encoded with the existing protected-payload codec. Its additional
authenticated data binds at least:

```text
kind=turn_input
runId + turnId + commandId + runVersion + inputDigest
```

Only Agent execution and recovery services may decode it. The decoded value is
rehashed and compared with the Turn intention before it leaves persistence.

Adding `turnId` to authenticated data is conditional on `kind=turn_input`.
The byte representation used by every existing v4 protected-payload kind must
remain unchanged, otherwise an upgrade would make valid historical ciphertext
undecryptable. A general AAD-format change requires a separately versioned
codec and key lifecycle; it is not part of this decision.

Snapshots are mandatory while a Run is active or recovering. After a Run is
terminal, encrypted snapshots follow the configured recovery and audit
retention period and are then deleted or cryptographically erased. A request
to erase Conversation data must first cancel or settle an active dependent
Run through an explicit coordinator; it must not silently remove execution
material from a recoverable Run.

### Recovery classification

Active-run recovery will fail closed with explicit issues for a missing Turn
input, digest mismatch, cause mismatch, or catalog mismatch. Runtime startup
does not fall back to rebuilding a missing snapshot from current Conversation
state.

### Schema and offline migration

This table changes the mandatory recovery artifact set, so Agent Control must
advance to schema v5. It cannot be added silently under schema v4.

- pristine or empty stores may create v5 directly;
- a v4 store containing any active or recovering Run cannot be backfilled from
  current Conversation state and must remain blocked until those Runs are
  explicitly settled under their original runtime;
- terminal-only history may be upgraded only under a fenced offline tool with
  an explicit policy for old admission receipts and retained execution input;
- production startup never runs this migration or invents a snapshot.

## Consequences

- Exact follow-up inference can recover without mutable or process-local model
  context.
- Sensitive admitted text is duplicated as encrypted execution material, so
  key management, retention, and erasure coordination become production
  requirements.
- The production inference input reader can become independent of live
  Conversation reads after admission while Conversation remains the sole
  business authority.
- Agent Control schema v5 and a fenced offline migration are required before
  production activation.

## Existing reusable components

- Turn intentions already persist an input digest and bounded summary.
- Conversation Authority already exposes immutable Message versions and
  content-digest verification.
- Agent persistence already supports protected Checkpoint, Effect, Plan, and
  Directive payloads through an authenticated codec.
- Agent command commits already enforce exact recovery artifacts in the same
  transaction as aggregate mutations.

## Implementation status

- Snapshot, commit/reference/reader ports, authenticated codec context, schema
  v5 table, and migration fence are implemented.
- Admission and causal `run.register_turn` commits atomically persist exact Turn
  input payloads.
- Active-run load/replay/recovery validates introduction version, digest,
  summary, cause, authority, message prefix, Catalog, ciphertext, and AAD.
- Production inference reads the exact protected snapshot for both initial and
  causal follow-up Turns; it does not reconstruct later input from Conversation.
- Retention and coordinated erasure remain a separate lifecycle deliverable.

## Verification

Required tests cover atomic Turn-plus-input commit, exact replay, encrypted
payload AAD drift, digest/summary/cause/catalog mismatch, missing input during
startup recovery, absence from Events and Public Projection, Conversation
edits after admission, active-Run deletion coordination, terminal retention,
and proof that no read path can rebuild Conversation from Agent snapshots.
