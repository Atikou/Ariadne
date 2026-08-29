# ADR-0005: Isolate control stores and encrypt Agent recovery payloads

- Status: Accepted
- Date: 2026-07-31
- Current-state refresh: 2026-08-26

ADR-0008 supersedes the original Session/Message ownership in `memory.db`.
ADR-0009 and ADR-0013 supersede the original Agent table layout and recovery
artifact set. Database isolation, owner fencing, encryption and offline
migration rules in this ADR remain authoritative.

## Context

Runtime command identity, Conversation facts, Agent execution facts and Public
Projection have different writers and recovery semantics. Sharing one SQLite
file would let unrelated components compete in one lock domain and would make
cross-domain failures look transactionally atomic when they are not.

Agent checkpoints, Turn inputs and Effect payloads may contain private model or
workspace content. Rejecting obvious credentials is not sufficient protection
for durable recovery material.

## Decision

### Physical ownership

Production uses four isolated databases:

| Database | Sole writer | Authoritative contents |
|---|---|---|
| `data/runtime-control/runtime-command.db` | `RuntimeCommandJournal` | command identity, digest, certainty and allowlisted replay outcome |
| `data/conversation/conversation.db` | Conversation Authority | Session, Message and Conversation-to-Agent Handoff |
| `data/agent-control/agent-control.db` | `AgentRunUnitOfWork` | Run, Turn, Attempt, Decision, Effect, Plan, Budget, Delegation, recovery and outbox |
| `data/public-projection/projection.db` | Projection Store | rebuildable public read model and commit cursor |

Each database has its own schema ledger, connection owner, close boundary and
path-scoped owner lease. No adapter may open another owner's database for
writes. Cross-store workflows use persisted Saga/Inbox/Outbox messages and
idempotent receipts; they do not use cross-database transactions or dual writes.

The owner lease is acquired before opening, migrating or recovering the
business database. A second owner fails immediately. If close is uncertain,
the process retains the fence until exit rather than admitting another writer.

### Schema and migration

- Production startup may initialize a pristine current schema.
- A non-empty incompatible schema fails with an offline-migration blocker.
- Startup never infers active Run state from legacy tables, performs dual
  reads/writes, or silently deletes historical authority.
- Offline migration must establish one writer, validate receipts and protected
  artifacts, and leave a durable audit record.

Current Agent Control persistence is schema v7 / ledger revision 55. Version
numbers are implementation details; the no-in-place-guessing rule is the ADR.

### Recovery encryption

Production checkpoints, Turn input snapshots, directive payloads, Effect input
and Effect result material use authenticated encryption owned by the Agent UoW.

- Electron Main owns the protected keyring and injects an ephemeral key set.
- The database stores key identity/rollback anchors, never plaintext keys.
- Public receipts, events, outbox and projection contain bounded references and
  digests rather than raw protected payloads.
- Missing keys, codec mismatch, rollback, corrupt authentication tags or
  credential-like forbidden material fail readiness.
- There is no plaintext production fallback.

### Public Projection

Projection is physically isolated because it is rebuildable and has different
retention/read semantics. It never becomes a second business authority. A
projector advances a source checkpoint only in the same transaction that
updates rows and appends its public commit.

## Consequences

- Conversation and Agent commits are not falsely presented as one SQLite
  transaction; Handoff uncertainty is explicit and recoverable.
- Runtime restart cannot use Trace, Renderer state or process memory as proof.
- Key loss or incompatible active history blocks startup and requires explicit
  operator action.
- Deleting a projection does not delete business facts; deleting protected
  execution material must first settle or cancel dependent Runs.

## Verification

Required evidence includes owner contention, close failure fencing, schema
rejection, empty-store initialization, keyring rollback/mismatch, corrupt
ciphertext, missing keys, cross-store crash points, exact receipt replay and
absence of plaintext credentials in public records.
