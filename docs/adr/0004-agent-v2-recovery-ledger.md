# ADR-0004: Agent v2 owns its recovery ledger and durable outbox lease

- Status: Superseded by ADR-0009 for the active Agent Control schema and UoW
- Date: 2026-07-31

The recovery invariants and encryption boundary remain in force. The v2 table
layout and single-Run commit shape described below are historical; active
production persistence is schema v7 / ledger revision 55 as extended by
ADR-0009 and ADR-0013. The v2 table names and migration numbers below remain
only as historical context.

## Context

`agent_v2_runs`, commands, events, and outbox rows establish one durable
aggregate writer, but an aggregate alone cannot resume model reasoning or an
external effect after process loss. The legacy paused-run snapshot and
process-local resource registry are not part of Agent Core's transaction and
must not become a second recovery authority.

Recovery payloads can also contain model context, tool input, or tool result
data. Persisting request headers, credentials, cookies, or raw authorization
would turn the recovery database into a credential store.

## Decision

Schema v44 adds two Agent-owned tables:

- `agent_v2_checkpoints` stores one immutable checkpoint per
  `(run_id, checkpoint_version)`. It binds the checkpoint to the resulting run
  version and stores a codec-protected JSON payload containing both the engine
  continuation and model context.
- `agent_v2_effect_payloads` stores one ledger row per effect. It binds the raw
  recoverable input and optional result to the aggregate's exact `effect_id`
  and `input_digest`.

Checkpoint and effect-payload changes are artifacts of an `AgentRunCommit`.
The SQLite adapter writes them inside the same `BEGIN IMMEDIATE` transaction as
the aggregate, normalized command identity, domain events, and outbox rows.
There is no standalone mutation API for either table.

The following invariants are fail-closed:

1. A `queued` run is recoverable without a checkpoint. Every `running`,
   `waiting`, or `recovering` commit must include a checkpoint that belongs to
   the run and exactly matches its current positive `checkpointVersion` and
   resulting aggregate version.
2. An effect payload must reference an effect present in the committed
   aggregate and must exactly match that effect's `inputDigest`.
3. Existing checkpoint/input/result payloads are immutable. An exact replay is
   a no-op; different content is a conflict.
4. A result may only be recorded when the aggregate says the effect has a
   known terminal result (`succeeded` or `failed`).
5. Recovery scans cover `queued`, `running`, `waiting`, and `recovering` runs.
   `queued` is a normal no-checkpoint variant; the other three states require
   the exact current checkpoint. Missing recovery material is returned as an
   explicit blocked item, while corrupt referenced material fails closed;
   recovery never guesses.

All payload persistence passes through an `AgentPersistencePayloadCodec` port.
The development codec stores ordinary JSON but rejects sensitive field names
and raw authorization-like values. A production composition must inject a
reversible authenticated-encryption codec or reject the payload; a redacted
preview can never replace authoritative recovery material. The codec identifier
and exact run/command/checkpoint/effect metadata are supplied as AAD and stored
with each row so a database cannot be decoded with the wrong implementation.
Payloads are never logged by this adapter.

Logical `command_digest` retains its v43 meaning and hashes only the normalized
domain command. Raw recovery payloads never enter that public SHA-256. Exact
artifact replay is checked by the UoW against the protected rows. Effect input
identity is owned by a separate Control-layer `AgentEffectInputDigester`, not by
AgentEngine or the persistence codec.

`AgentRunBinding` persists an immutable `objectiveRef` to either a Conversation
message or a parent delegation. The referenced text remains owned by its source
store and is supplied to AgentEngine as turn input; the aggregate, started
event, and outbox do not duplicate it.

Schema v44 also adds durable lease columns to `agent_v2_outbox`. Claiming is an
atomic compare-and-set operation ordered by cursor. Concurrent claimers receive
disjoint rows; an expired lease can be reclaimed after process loss. Publishing
requires the exact claim id and marks only those rows as published. Domain
event history remains protected by `ON DELETE RESTRICT`.

Production persistence is physically owned by the Agent UoW at
`<dataRoot>/data/agent-control/agent-control.db`. Its independent schema version
2 materializes Agent ledger revision 45 directly: the six `agent_v2_*` tables
plus an Agent-owned metadata table and migration audit table. Revision 45 makes
the aggregate's durable Turn/Inference Attempt ledger and immutable Tool
Catalog binding mandatory. Dedicated schema version 1 contains revision 44
aggregate JSON and therefore fails startup with an explicit offline-migration
requirement; Runtime does not add missing fields or reinterpret it online. The
UoW never opens an arbitrary caller-provided database path. A pristine file is
initialized once; unversioned non-empty, older, newer, incomplete, or
foreign-table schemas fail closed. `agent_control_metadata` reserves
`keyring_generation` and `active_key_id` for the Runtime-owned keyring rollback
anchor; Electron Main does not write this database.

## Consequences

- A Runtime process can reopen the dedicated `agent-control.db` and reconstruct an active Agent run
  without consulting `PausedRunStore` or `ResourceRegistry`.
- External effects still execute outside the database transaction. The ledger
  distinguishes recoverable intent/result data from an uncertain started
  effect and therefore does not authorize blind retries.
- The independent SQLite connection remains explicitly closeable and this
  adapter's instances share one per-database transaction coordinator. No
  conversation or transport-command writer shares its file or lock domain.
- This slice intentionally does not connect `RuntimeFacade` or
  `createAppContext`; production routing is a later vertical slice.

## Production wiring blockers

- `StrictJsonAgentPersistencePayloadCodec` is a development fail-closed codec,
  not a production plaintext fallback. Production needs authenticated
  encryption, key rotation, and retention/crypto-shred policy.
- The UoW exposes an atomic startup verification/initialization operation for
  `keyring_generation` and `active_key_id`. Initialization is allowed only for
  an entirely empty Agent store; an existing anchor is never advanced online.
  Rotation still needs a separately fenced offline CAS operation while the
  Agent writer is quiescent. Main must not acquire a direct connection.
