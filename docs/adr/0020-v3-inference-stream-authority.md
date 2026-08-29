# ADR 0020: v3 inference stream authority and replay

- Status: accepted for implementation
- Date: 2026-08-28
- Scope: exact Agent inference, Public Projection, Renderer

## Context

The production v3 Agent path commits one protected inference result and later
projects one terminal assistant message. Provider token and reasoning deltas
previously did not cross that path. The remaining legacy
`companion.token.delta`/`companion.reasoning.delta` events do not identify an
exact v3 Turn attempt, cannot be recovered through Public Projection, and must
not be reused as an Agent stream.

DeepSeek Harness uses durable `assistant/chunk` session events and one shared
assembler, then appends a separate final `assistant/message`. Ariadne has a
different ownership split: Agent Control owns protected execution and Public
Projection owns recoverable UI state. The same authority rule must therefore
be implemented across those two stores rather than by introducing a second
conversation log.

## Decision

### 1. Identity and ordering

Every v3 inference stream is identified by the exact tuple:

```text
runId + turnId + attemptId
```

Every observed chunk additionally carries a positive, contiguous `sequence`
and one channel: `token` or `reasoning`. A gap, duplicate with different
payload, or attempt mismatch is a protocol-integrity failure. Provider request
IDs and process-local callback identities are not public authority.

### 2. Storage boundary

Chunks are appended through a dedicated inference-stream source into the
durable Public Projection stream. They do not become AgentRun events and do not
enter the Agent Control transaction, command receipt, checkpoint, or protected
Turn-input payload.

The stream projector owns a bounded per-attempt representation and explicit
retention. It must reject an unbounded stream before a single Projection commit
or Snapshot can exceed the existing byte limits.

### 3. Terminal authority

Chunks are presentation evidence only. They never complete a message and are
never a recovery source for model context.

The terminal assistant message projected from the committed Agent inference
result remains the only final content authority. Renderer must replace or hide
partial stream presentation when that message arrives; it must never construct
the terminal message by concatenating chunks.

### 4. Interruption and recovery

An open stream has one of these terminal states:

- `committed`: the exact inference result crossed the Agent Control commit;
- `interrupted`: transport, cancellation, shutdown, or restart ended the
  attempt without a matching committed result.

At Runtime startup, reconciliation compares every open projected stream with
the exact AgentRun attempt. A stream without a committed succeeded attempt is
atomically projected as `interrupted`. A committed attempt may be projected as
`committed`; its terminal assistant message remains authoritative even if the
last stream-state commit was lost.

### 5. Provider and assembler boundary

OpenAI-compatible and Anthropic adapters may decode different wire protocols,
but both feed the shared bounded content assembler defined by ADR-0021. The
protected exact response is an ordered `text/reasoning/tool_call` block
sequence; public running chunks intentionally remain only `token/reasoning`
presentation evidence. Adapters may not maintain a second final-content path.

Reasoning is kept in its own channel and is excluded from later model Turn
inputs unless an exact Provider continuation contract explicitly requires it.
Public text passes the same redaction and byte checks as other Projection text.
Raw token chunks on the exact Agent path remain protected because they carry
the JSON Directive and may contain Tool arguments, workspace paths, or other
non-public execution data. They are assembled and strictly parsed first; only
the parsed `respond.content` field may be copied into public token chunks.
Native Tool inputs and `invoke_tools` payloads never cross this projection
boundary.

## Rejected alternatives

- Reusing legacy Companion delta events: no exact attempt identity or v3
  Projection replay.
- Writing every token into Agent Control: inflates the command/checkpoint
  transaction and makes UI cadence part of execution authority.
- Keeping chunks only in Renderer memory: reconnect and Runtime restart cannot
  distinguish interrupted partial content from a final answer.
- Reconstructing final content in Renderer: creates two competing final-message
  authorities and makes chunk loss user-visible as data corruption.

## Acceptance criteria

1. Protocol tests reject sequence gaps, identity drift, oversized text and
   contradictory terminal states.
2. Projection persistence replays chunks in order and restores a bounded open
   stream from a Snapshot.
3. Runtime restart converts a genuinely open stream to `interrupted` without
   modifying the committed assistant message.
4. OpenAI-compatible and Anthropic adapter tests prove token and reasoning
   channel mapping through the shared assembler.
5. Renderer tests prove chunks are attempt-scoped and terminal content comes
   only from the authoritative message projection.
6. Electron smoke observes at least two chunks, reconnects Projection state,
   and finishes with exactly one committed assistant message.
