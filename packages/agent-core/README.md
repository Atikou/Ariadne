# Ariadne Agent Core

`@ariadne/agent-core` is Ariadne's first-party, platform-independent Agent
domain and application boundary.

The package owns:

- the `AgentRun` aggregate and its state invariants;
- exact permission, plan, and recovery decisions;
- the external-effect state machine;
- durable Turn intention and inference-attempt recovery state;
- Agent commands and domain events;
- the `AgentEngine` decision port;
- the single `AgentRunCommandService` write path and its atomic unit-of-work
  port.

`AgentRun` stores only an immutable `objectiveRef`. Conversation messages and
delegation text remain in their authoritative stores and are provided to the
engine as turn input; aggregate events and the outbox never duplicate that raw
text.

Every admitted Run requires one exact `AgentRunBinding` v3 snapshot. It pins
the session, versioned objective digest, workspace revision/grant/access/scope,
model settings revision, policy identity/revision/permission mode, capability
grants, Tool catalog revision/digest/allowlist, and a durable budget grant.
Conversation objectives carry `messageVersion + contentDigest`; delegated
objectives carry `parentRunId + delegationId + objectiveDigest`. There is no
optional or legacy Binding shape, and policy no longer duplicates budget
limits such as `maxTurns` or `maxToolCalls`.

The durable budget grant owns a non-negative vector for model turns, Tool,
read, write, shell, and micro-USD consumption together with a canonical
deadline. A root grant has source `root`; a delegated grant has source
`parent_allocation` and pins its parent Run, parent grant, and delegation.
`budget.runId` must equal the aggregate Run ID. The pure
`assertAgentChildRunBindingSubset` guard rejects delegation unless the child
uses the same session and workspace snapshot, references the parent objective,
and only narrows workspace access/scope, capabilities, Tool allowlist, budget,
deadline, permission mode, and model selection.

Every model call is owned by a persisted Turn attempt. The dispatcher commits
`started` before invoking `AgentEngine`; a reopened `started` or `uncertain`
attempt is recovery work and is never sent to the Engine again. An explicit
retry creates a distinct attempt and Provider idempotency key while preserving
its causal `causedByAttemptId` and recovery-decision identity.

After Engine I/O, `DefaultAgentInferenceDirectivePlanner` validates the
Directive's bounded shape and exact pinned Tool identity against the
`availableTools` snapshot already bound by the Turn input digest. Every
available Tool, raw invocation, committed invocation, and Effect carries one
exact `tool` value containing `catalogId + revision + digest` and
`toolName + toolVersion + providerId + contractDigest`; Core never resolves a
committed Tool again by name. The single
`run.record_inference_attempt_result` commit then
persists the terminal Attempt result and applies the Directive in the same Run
version: terminal Run state, checkpoint, plan/permission Decision, or every
tool Effect intention. Trusted `allow` Effects are already `authorized` in
that version; any single `wait` creates one exact waiting permission, while an
unsupported multi-tool wait fails deterministically without creating a partial
Effect.

Before deriving any Effect or recovery payload,
`DefaultAgentInferenceDirectivePlanner` calls the pure
`AgentToolAdmissionPolicy` port once for every invocation. The policy receives
the exact Run/Turn/Attempt, pinned catalog snapshot, requested capabilities,
scope, workspace binding, and a canonical data-only input clone. It returns
`allow`, `wait`, or a bounded `deny`; allow/wait carry the exact admitted Tool,
capability set, non-expanding normalized scope, and normalized input. The
Planner rejects any Tool/capability drift or scope expansion and creates the
committed invocation and Effect only from those admitted values. Ask-mode
always becomes `wait`. A batch containing any deny, or a multi-invocation batch
containing any wait, fails deterministically with zero Effect payloads. Policy
exceptions and malformed policy decisions are infrastructure failures and
escape to the inference dispatcher's uncertain-outcome path instead of being
disguised as denial. Only the policy-normalized canonical input is digested and
committed.

Raw tool input is never stored in `AgentRun` or an outbox event. Its committed
Directive representation contains only the input digest and stable Effect
identity; the raw bounded JSON exists solely as the matching `record_input`
recovery artifact in the same transaction. No caller may interpret a
succeeded Directive later through a second register/authorize/decision
command.

New work enters Core through `AgentRunAdmissionService.admit`. Admission uses a
single `run.admit` command and one aggregate/UoW commit to create version 1 in
the `running` state, register the first Turn and inference intention, persist
checkpoint 1, append its outbox events, and retain the replay receipt. A caller
must not compose `run.start`, `run.begin`, and `run.register_turn` as an
admission workflow because those commands expose partially admitted durable
states across three versions.

All public identities are already canonical when they cross the Core boundary:
they contain 1 to 256 characters and equal their trimmed representation. Core
rejects non-canonical identities; persistence and projection adapters must not
silently trim or otherwise rewrite them. Domain timestamps use millisecond ISO
8601 with an explicit `Z` or numeric offset, and persisted counters and
revisions are safe integers. Every set-like public array is data-only,
duplicate-free, and strictly ascending by JavaScript/Unicode code-unit order;
Core rejects semantically equivalent but reordered input.

The package deliberately has no dependency on Electron, Node APIs, SQLite,
schema libraries, model providers, tool implementations, or the Runtime
composition root.

## Persistence contract

An `AgentRunUnitOfWork` implementation must atomically:

1. compare `expectedVersion` with the currently persisted run version;
2. persist the next aggregate version;
3. append every event in the commit;
4. retain the normalized command digest and committed result for idempotent
   `commandId` replay;
5. for `run.admit`, persist checkpoint 1 and the four admission outbox events
   in that same transaction.

The serialized aggregate requires the complete `bindingVersion: 3` Binding,
top-level `turns`, the complete Binding snapshot on every Turn intention, and
the pinned `tool` value on every committed Tool invocation and Effect. Adapters
must reject older shapes through an explicit store-format migration; they must
not synthesize missing Binding or Turn data while reading.

If the comparison fails, the adapter must throw
`AgentRunVersionConflictError`. A command ID may never be reused for another
run or for different normalized command content.
