# ADR-0008: Conversation authority and Agent handoff

- Status: Accepted
- Date: 2026-07-31
- Supersedes: ADR-0005 only for Session/Message ownership in `memory.db`;
  ADR-0005 control-store isolation and recovery-encryption decisions remain in force.

## Current implementation status (2026-08-26)

Session/Message authority, all four Handoff outbox transitions, the cross-store
coordinator, fixed-point producer lifecycle, durable execution-intent receipt,
terminal Agent-result projection and the default production execution pipeline
are connected. Historical-store offline migration and real-process crash
acceptance remain separate release gates.

## Context

Conversation messages and Agent runs are different authorities. A message must
be durable before it can request a Run, while the Agent control store must not
copy raw message content. SQLite cannot provide one safe transaction across
two independently owned database files. Retrying an ordinary service call
after a process crash can therefore create a second Run or lose the link from
the original message.

The previous application also spread conversation facts across compatibility
stores and reconstructed missing relationships in UI or facade code. That
made a local bug propagate across storage, runtime, and renderer layers.

## Decision

### Authority and data boundaries

`data/conversation/conversation.db` is the only v3 authority for Session,
immutable Message versions, and the Conversation-to-Agent handoff. It has one
writer, one schema ledger, one owner lease, one shutdown boundary, and the same
verified SQLite contract as the other control stores: foreign keys enabled,
zero busy timeout, WAL, and `synchronous=FULL`.

The Agent store owns Run, Turn, Attempt, Decision, Effect, Checkpoint, Event,
Outbox, and command receipt facts. It stores only an objective reference and
digest. Conversation outbox, Agent receipts, checkpoints, projections, and
logs must not contain raw message text, provider input, credentials, or
absolute workspace paths.

Context and knowledge data may reference Conversation identities, but they do
not become a second Session or Message authority.

### Handoff protocol

Each accepted message owns one durable saga:

```text
MessageAccepted
  -> AgentRunRequested
  -> AgentRunLinked
  -> AgentResultProjected
```

Every transition uses an exact `commandId + fingerprint`, expected-version
CAS, durable Inbox identity, Domain Event, and Outbox message in one
Conversation transaction. Event and Outbox payloads are projected by one pure
domain function from the committed saga version; adapters do not maintain a
second mapping.

The cross-store coordinator claims Conversation Outbox messages by durable
cursor and lease. It acknowledges a message only after the downstream domain
commit and the following Saga transition have succeeded. A crash after either
commit but before acknowledgement repeats the same stable command IDs:

- Agent admission replays the Agent command receipt without rereading the raw
  message or mutable catalog inputs;
- Saga linking replays the Conversation command receipt;
- payload drift under an existing identity fails closed.

No cross-database transaction, dual write, best-effort repair, UI inference,
or fallback Run creation is permitted.

### Dependency direction

`runtime/src/conversation` contains the pure Conversation domain and may depend
only on itself. Runtime control use cases depend on that domain and on explicit
ports. Persistence adapters implement type-only control ports and may depend
on pure Conversation validation/projection values. They may not import control
implementations. Composition is the sole place that connects the Conversation
outbox, Agent admission, and Saga service.

### Schema cutover

Conversation schema v1 is a pristine-store contract, not a rolling production
migration target. Before production routing is enabled, the same v1 definition
must include authoritative Session and immutable Message-version tables in
addition to the handoff ledger. Any non-empty older or structurally different
store requires an explicit fenced offline migration. Runtime startup never
guesses, copies, repairs, or dual-reads historical conversation state.

## Consequences

- A message-to-Run handoff converges after process loss without duplicating a
  Run or storing raw message content in Agent control.
- Conversation and Agent databases can be recovered and fenced independently.
- Renderer and facade code cannot fabricate missing links; they consume only
  authoritative projections.
- Session/Message authority, the outbox coordinator, Agent-result projection
  and the default execution/recovery Composition are connected. Offline
  migration and real-process crash acceptance remain separate gates; Handoff
  completion alone is not proof of a complete product Agent loop.

## Verification

Tests must cover exact duplicate replay, command-digest drift, CAS conflicts,
kill immediately before and after every commit, restart and lease-expiry
reclaim, exact ACK, owner contention, schema/ledger tampering, raw-content
absence, and a zero-violation architecture gate.
