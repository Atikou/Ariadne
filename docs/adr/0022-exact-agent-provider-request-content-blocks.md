# ADR 0022: exact Agent Provider request content blocks

- Status: accepted and implemented
- Date: 2026-08-29
- Scope: committed Tool history, protected input recovery, Provider serialization and compaction

## Context

ADR-0015 projected committed Tool exchanges as Ariadne JSON text. That preserved
causal identity but discarded the Provider-native Assistant Tool-call and Tool
result relationship. Models received a different history shape from the one
used for current native Tool calls, while the committed Directive stored only
an input digest and could not safely recreate raw arguments by itself.

## Decision

The exact inference request uses one Provider-neutral block union:

```ts
type ExactAgentModelInferenceRequestContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      providerToolName: string;
      input: AgentToolJsonValue;
    }
  | {
      type: 'tool_result';
      effectId: string;
      toolCallId: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      output: AgentToolJsonValue;
    };
```

Before the durable `inference_started` checkpoint, the Engine validates the
continuation against the committed source Turn, Attempt, Directive and Effects.
It then reads each raw Tool input from the existing protected Effect payload and
requires the exact Run, Effect and `inputDigest` to match. Tool identity,
capabilities and scope must still match the immutable prepared Catalog. Missing
or mismatched protected input fails deterministically before Provider I/O.

Internal Tool-call ids are replaced with deterministic request-safe hashes.
OpenAI-compatible adapters serialize Assistant `tool_calls` followed by `tool`
messages. Anthropic serializes `tool_use` followed by `tool_result` blocks. The
embedded local boundary projects the same blocks to its native `ChatMessage`
Tool fields. Provider requests do not receive Effect ids unless compaction has
intentionally placed one inside a retrievable spill manifest.

Request validation is strict: block keys and role compatibility are exact;
Tool aliases must exist in the advertised request contracts; Tool-call ids are
unique; results must resolve the complete outstanding call set exactly once;
and every input/output must be finite, acyclic JSON.

Long-context grouping operates on typed identities rather than parsing text.
Tool-call/result pairs remain atomic. Oversized outputs are replaced in-place
by `ariadne.tool-result-spill.v1` objects while preserving the typed result
block and its request-local Tool-call identity.

## Consequences

- Current native Tool calls and historical Tool exchanges share one semantic
  request shape across remote and embedded models.
- Raw Tool input remains protected and single-owned; it is not duplicated into
  the committed Directive, Attempt envelope or Public Projection.
- The retired `ariadne.agent-effect-results.v3` text transport remains only as
  historical ADR context, not a production Provider protocol.
- Durable image attachments now extend this block boundary through ADR-0023.
  Adapter-private replay state remains separate future work.

## Verification

Required coverage includes exact protected-input digest matching, no Provider
I/O on mismatch, multi-batch identity pairing, OpenAI and Anthropic native
serialization, embedded-local projection, strict orphan/duplicate rejection,
typed spill pruning, full Runtime tests and repository architecture gates.
