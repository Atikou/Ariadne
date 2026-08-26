# ADR-0009: Immutable plans, durable budgets, and ordinary child Runs

- Status: Accepted
- Date: 2026-07-31

## Current implementation status (2026-08-26)

`agent-control.db` uses schema version 5 / ledger revision 49. The active
`agent_v3_*` authority tables cover Run, command receipt, Event/Outbox,
Checkpoint, protected payloads, immutable Plan/Budget, Delegation/Child Run,
Turn input and durable execution intent. `AgentRunTransaction.commitCommand`
is the sole mutation primitive; old v2 production tables and the single-Run
commit fallback are gone.

Default production Composition routes Conversation admission, exact inference,
Effect dispatch, continuation and recovery through this authority. The first
SubAgent product provider is now connected end to end: model Directive, atomic
Parent/Child admission, ordinary Child scheduling, terminal observation,
protected result continuation and Public Projection/Renderer status. Historical
database migration and real-process SubAgent crash acceptance remain pending.

## Context

The legacy planning, budget, recovery, and sub-agent paths keep related facts
in separate mutable stores and in-memory maps. A Plan version can be updated in
place, budget counters lose information across restart, and a detached child
workflow can bypass the normal Agent Run control path. These are independent
truth sources, so repairing one path can invalidate another.

The current Agent UoW commits one Run at a time. It cannot atomically reserve a
parent budget, create multiple children, and persist every delegation link.
Adding more facades on top of that limit would preserve the failure mode.

## Decision

### Multi-Run control transaction first

Agent Control will move to a schema and UoW that commits one logical command
across a sorted set of Run mutations. One receipt records every touched Run
and resulting version. The same SQLite transaction owns:

- parent and child Run versions;
- immutable Plan payload references;
- Budget ledger entries;
- Delegations;
- checkpoints and protected payloads;
- Inbox receipts, Domain Events, and Outbox messages.

All expected versions are validated before the first write. Any invalid child,
budget allocation, identity collision, or artifact failure rolls back the
entire command. Existing schema v2 stores require an explicit fenced offline
migration; Runtime does not dual-read v2 and v3.

### Immutable Plan versions

A Plan is addressed only by `planId + version + contentHash`. Its content hash
uses recursive canonical JSON and excludes approval state, execution progress,
audit timestamps, and UI data. Content is stored as a protected artifact;
Run, Decision, Event, and Outbox facts keep only the exact reference.

Creating a Plan version never updates a previous version. Approval must match
the Run, checkpoint version, Plan identity, version, and content hash.
Execution reads the approved exact reference and never resolves `latest`.

### Durable Budget ledger

Budget is a vector rather than a process-local counter:

```text
modelTurns, toolCalls, readCalls, writeCalls, shellCalls, costMicrousd
```

Root grants and parent allocations are immutable. Inference reserves a model
turn and bounded cost before provider I/O, then settles the integer actual
cost. Effect dispatch consumes the tool and category charge before tool I/O.
An uncertain provider or tool result retains its reservation until explicit
recovery settles or releases it.

Runtime deadlines are persisted timestamps. Policy fields such as
`maxTurns/maxToolCalls` are removed after the ledger cutover so there is only
one execution budget truth.

Sibling allocations serialize in the Agent UoW. Their total can never exceed
the parent's currently available vector. A terminal child releases only its
unconsumed allocation.

### Child Runs and Delegations

“SubAgent” is not a separate domain entity. A child is an ordinary queued
`AgentRun` connected by an immutable Delegation. Creating children atomically
persists the parent waiting state, all queued child Runs, budget allocations,
protected objective artifacts, Events, and Outbox messages.

Every child binding is a non-expanding subset of its parent:

- identical workspace snapshot; access can only narrow;
- workspace scopes and capability scopes are subsets;
- identical pinned Tool Catalog revision/digest, with an allowed-tool subset;
- each tool remains covered by the child's capability grant;
- budget vector and deadline do not expand.

Queued-child admission reuses the normal Agent inference path. A `ChildRunPort`
accepts only immutable Run, Delegation, grant references, command identities,
and deadlines. It never receives an `AgentLoop`, `ToolRegistry`, workspace root,
workflow object, or process-local completion Promise.

Child terminal Events propagate through durable Outbox/Inbox messages. The
parent resumes only after every required child reaches a terminal state. Parent
cancellation enters an explicit `cancelling` state and cannot claim completion
while a child or external I/O remains non-terminal or uncertain.

## Consequences

- Plan approval, spend, recovery, and parent-child lifecycle become Agent
  Control facts rather than synchronized caches.
- The multi-Run UoW, schema v5 foundation, Plan/Budget/child Run authority,
  and durable execution-intent ledger are complete. Production
  wiring must use this path and must not introduce another transaction path.
- Non-empty schema v1-v3 databases fail closed with
  `agent_control_offline_migration_required`; production startup never mutates
  them in place.
- Legacy Plan stores, process-local budget managers, paused-run snapshots, and
  SubAgent workflow maps are removed slice by slice after their writer routes
  are closed. They are never retained as a production fallback.
- Active legacy Runs cannot be safely inferred into the new model. Offline
  migration may import terminal history as a diagnostic projection, but old
  approvals and live execution state require explicit recovery or reapproval.

## Verification

Required tests include atomic parent-plus-N-child creation, concurrent sibling
over-allocation, exact Plan hash approval, provider/tool kill boundaries,
reservation recovery, child-grant escalation attempts, duplicate and
out-of-order terminal propagation, parent-cancel races, grandchild subset
checks, missing protected artifacts, non-empty schema-v2 startup rejection,
and absence of raw objectives, paths, provider data, and credentials from
receipts, Events, and Outbox messages.

The automated suite now verifies the multi-Run foundation plus exact Plan hash
approval, reservation settlement and release, concurrent sibling
over-allocation rejection, atomic parent-plus-two-child persistence, duplicate
and out-of-order terminal propagation, parent cancellation, grandchild
escalation rejection, transaction rollback on delegation failure, restart and
exact replay, and recovery detection for missing or corrupt Plan, Budget, and
Delegation facts. It also verifies that raw objectives and directive bodies do
not enter public authority records, missing protected artifacts fail closed,
credential-like payloads are rejected before persistence, and two independent
effect inputs from the same command and Run can coexist without weakening their
exact command/version foreign-key binding.

Default Composition owns initial Inference, delegated initial Inference,
Effect/Child-result continuation and durable recovery scheduling. The one-shot
ordinary Child provider has production-pipeline integration coverage. Offline
migration, external/continuable providers and a real process/window SubAgent
smoke remain outside the accepted scope.
