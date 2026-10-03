# ADR-0011: One durable public projection stream

- Status: Accepted
- Date: 2026-07-31

## Context

At decision time, the transition architecture had two incompatible public truths.
Agent Run versions published `run.changed` events, while `runtime.snapshot.get`
still reads legacy Facade stores. Renderer code then synthesizes Runs from
Messages, joins timestamps, fetches missing Decisions, and writes terminal Run
state into Activity views. A refresh can consequently remove a Run that a
valid event just added.

IPC delivery is also not an end-to-end acknowledgement. Runtime acknowledges
its event journal after invoking a synchronous sink, Main advances an in-memory
cursor after `webContents.send`, and Renderer has no durable ACK. Runtime crash
status is not pushed through Preload, so UI can remain falsely ready.

Splitting these repair routines into smaller Renderer stores would preserve the
wrong ownership model.

## Decision

### Projection is the only public entity writer

A rebuildable `data/public-projection/projection.db` owns the public read model
and one ordered stream. Domain owners publish durable facts; projectors consume
those facts and transactionally update public rows, append one Projection
Commit, and advance the exact source checkpoint.

Each commit contains an ordered set of changes across:

- Session;
- Message;
- Run and its Activity view;
- Decision;
- Model availability;
- Diagnostics;
- bounded inference heads for exact Run/Turn/Attempt identities (added after the original activation).

Changes that must be observed together, such as `Run waiting_permission` and
its pending Decision, are written in one Projection Commit. Every Decision
carries `sessionId`; every Message-to-Run relationship comes from the
Conversation Handoff Saga. Projectors never infer relationships from display
order, process-local workers, files, or mutable Facade maps.

The store enforces unique `eventId` and unique feature aggregate versions.
Exact replay is a no-op; identity or payload drift makes Projection unhealthy
and leaves the source message unacknowledged. Unhealthy is a latched state:
all later append, read, and Snapshot work fails while close remains available
to retain the owner-fence shutdown path. Shape, size, and public-payload input
rejection before admission does not poison the store.

### Snapshot plus pull-based replay

The public projection contract is reset atomically to epoch `4.0`. Existing
`.v3` command names identify the command family, not storage compatibility:

```ts
interface PublicProjectionSnapshot {
  contractVersion: '4.0';
  streamId: string;
  cursor: number;
  cursorDigest: `sha256:${string}`;
  capturedAt: string;
  sessions: readonly SessionView[];
  messages: readonly MessageView[];
  runs: readonly RunView[];
  decisions: readonly DecisionView[];
  models: readonly ModelView[];
  diagnostics: readonly DiagnosticView[];
}
```

`streamId` survives ordinary Runtime restart. It changes only when the
Projection store is rebuilt, migrated incompatibly, or restored to another
history. Renderer starts with one atomic Snapshot, then pulls commits after its
cursor. Projection push notifications are availability wake-ups and carry no delivery
authority. The additional live inference lane described below also carries no durable authority.

Cursor zero has one explicit genesis digest. Every committed cursor stores a
domain-separated digest of the prior history digest, cursor, and canonical
Commit digest. A replay request supplies both `afterCursor` and `afterDigest`;
an OK batch supplies `nextCursor` and `nextDigest`. This detects a restored or
forked database even when it reused the same numeric cursor and copied the old
`streamId`. An explicit Projection reset or restore-to-different-history must
also rotate `streamId`; copying old metadata is not a reset protocol.

Stream changes, expired cursors, cursor gaps, and contract changes return
`reset_required`; Renderer discards the whole cache and requests a new
Snapshot. It never repairs one feature by calling Message, Run, Permission, or
Plan list commands.

The store validates the complete prospective heads Snapshot inside the same
write transaction before COMMIT. A Commit that would make the full Snapshot
exceed its public byte bound rolls back, leaving the prior cursor and Snapshot
readable. Read batches have their own whole-envelope byte bound in addition to
the per-Commit bound. Rows are iterated until either the requested count or
byte budget is reached; no request materializes the maximum count of maximum-
size Commit JSON values at once. Batch validation requires contiguous cursors,
matching next tokens, full Commit safety checks, and non-empty progress when
`hasMore` is true.

Absolute-path and credential pattern rejection is a final public-boundary
guard, not a classifier that can prove arbitrary text safe. Production
projectors must still emit explicitly public/redacted DTO fields and opaque
resource references after the authoritative secret-egress policy.

### Renderer ownership

`ProjectionCache` validates every change in a commit and applies the entire
commit through one immutable state replacement. It is the sole writer of
public DTOs. Session, Message, Run, Decision, Model, and Diagnostics feature
stores expose selectors, subscriptions, and command methods only; they do not
write one another.

### Live inference display and incremental views (2026-09-05)

Live chunk events may be duplicated, lost, or first observed midway through an Attempt.
Renderer buffers a bounded suffix, requests the existing Projection protocol on a gap,
and joins only a contiguous suffix onto a durable head with the same identity. A stale
durable streaming head must not hide a newer contiguous live prefix or revive a terminal
Attempt. `committed` and `interrupted` remain terminal; the final Message remains the
authoritative answer. Resetting the Projection epoch clears ephemeral stream state.

The Main delivery cursor belongs to a Runtime process instance. Creating a replacement
instance resets that cursor, including automatic crash recovery; otherwise new low
cursors would be suppressed by the prior process watermark.

Collection identities are retained when unchanged. Derived feature records and their
subscribers use those identities; token updates do not notify Session, Model, Run or
Decision subscribers. Live display publishes are coalesced, while durable commits and
termination remain immediately observable. These optimizations do not weaken atomic
cross-feature validation or introduce another public writer.

Command responses contain receipts and update only `PendingCommandStore`.
Optimistic UI state must not fabricate a Message, Run, Decision, Activity, or
public Diagnostic. Local transport errors live in a separate UI error store.

Runtime lifecycle status is not a persisted domain event. Electron Main sends
a separate typed lifecycle snapshot/event through Preload. Crashed or
restarting status immediately disables commands independently of Projection
replay.

### Atomic activation

Contract v3, Runtime projection queries, Main/Preload transport, and Renderer
ProjectionCache activate together. The activation required:

- Run and Decision commands have left the legacy Facade;
- Session and Message authority is in Conversation Store;
- Handoff provides stable Session/Message/Run references;
- every v3 projector and Snapshot row is available.

The activation commit deletes legacy public writers and Renderer repair code.
There is no production mode that merges v2 Snapshot entities with v3 commits.

## Consequences

- The 8 MiB atomic Snapshot remains a hard capacity boundary. The store now
  rejects the first Commit that would cross it, but production still needs an
  explicit retention/compaction or a future paged-bootstrap contract before
  unbounded conversation history can be projected.
- the removed `RuntimeFacade.snapshot()`, message-derived Runs, missing-Decision repair,
  command-result entity writes, and UI Activity finalization are removed rather
  than redistributed.
- Old and new Run projectors converge to the Agent Core projector before v3
  activation.
- Main no longer owns a replay cursor or gap-repair algorithm.
- The production entry now uses `RuntimeKernelApplication` and
  `DefaultAgentControlRuntimeFactory`; no legacy projection writer is allowed.
- The Projection store is rebuildable from domain owners and is never a new
  business authority.

## Verification

Tests cover kill before and after domain and Projection commits, source ACK
loss, Snapshot concurrency, duplicate batches, cursor gaps, stream changes,
payload drift, Runtime crash/restart status, atomic Run-plus-Decision changes,
stable Saga links, command-response loss, Renderer reload, session-switch
races, Projection corruption, and a real Electron Runtime kill/recovery smoke
with no false ready state or synthesized domain entities.
