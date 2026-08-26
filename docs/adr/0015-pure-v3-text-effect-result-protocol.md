# ADR-0015: Pure-v3 Text Effect-Result Protocol

- Status: Accepted
- Date: 2026-08-01

## Context

The current model-input message shape permits `role: 'tool'` but carries only
`role + content`. It cannot bind a result to the committed `toolCallId` that
introduced the Effect. The production Engine adapter drops any additional
identity, and the exact model gateway rejects Tool-role messages because it
cannot serialize them without changing their meaning.

Adding only a `toolCallId` to a Provider request would still be incorrect.
Provider-native Tool result protocols also require a matching prior Assistant
Tool-call block. Ariadne v3 deliberately asks the model for one text-only
Directive and rejects native Tool calls, so those Provider-native facts do not
exist.

## Decision

### Replace the ambiguous Tool message

The internal Turn input becomes a discriminated data-only union:

```ts
type AgentTurnInputMessage =
  | {
      kind: 'text';
      role: 'system' | 'user' | 'assistant';
      content: string;
    }
  | {
      kind: 'effect_result';
      effectId: string;
      toolCallId: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      result: AgentJsonValue;
    };
```

`effect_result` is an Ariadne execution fact, not a raw Provider message. Its
Effect and Tool-call identities must match the causal batch in ADR-0014. The
complete union participates in the Turn input digest and protected snapshot.

### Canonical text transport

`ProductionAgentEngineAdapter` will render a consecutive causal result batch
as one canonical text message:

```json
{
  "protocol": "ariadne.agent-effect-results.v3",
  "sourceDirectiveDigest": "sha256:...",
  "results": [
    {
      "effectId": "...",
      "toolCallId": "...",
      "status": "succeeded",
      "result": {}
    }
  ]
}
```

The batch is emitted as bounded user-role text after the canonical Assistant
representation of the committed `ariadne.agent-directive.v3` Tool Directive.
Ordering follows the committed Directive. No System message, unrelated text,
or result from another batch may appear between those two semantic records.

The exact model inference port and its production gateway accept only text
roles `system`, `user`, and `assistant`. They never emit a Provider-native Tool
role, Tool-call object, Tool-use block, or fallback request. The existing
requirement that the response contain zero native Tool calls remains in force.

If native Provider Tool protocols are introduced later, they require a new
versioned protocol that models both Assistant Tool-call and Tool-result blocks.
They cannot be inferred from a v3 text Directive.

### Protection and validation

Effect result bodies are decoded only while constructing an authorized Turn
input and are re-encrypted in that Turn's snapshot. They are not included in
Run aggregates, Events, Outbox, Public Projection, recovery notices, or logs.
The adapter validates exact object keys, collection and byte bounds, unique
Effect and Tool-call IDs, canonical order, and the source Directive digest
before model transport.

## Consequences

- Every result retains its durable Ariadne `toolCallId` without pretending
  that the Provider previously emitted a native Tool call.
- One text protocol works across exact text-capable model transports.
- Turn input digests change because message semantics become explicit; a
  fenced schema and protocol cutover is required.
- Provider-specific native Tool optimizations remain unavailable in v3.

## Existing reusable components

- The Engine already requires the strict `ariadne.agent-directive.v3`
  text-only response envelope.
- Effects and committed Tool invocations already retain exact `toolCallId`
  values.
- The production gateway already rejects Tool-role input and nonzero native
  Tool-call responses rather than falling back.
- Canonical JSON hashing and bounded protected payload primitives already
  exist.

## Implementation status

- Core uses the closed v3 message union and validates complete causal Effect
  result batches.
- `ProductionAgentEngineAdapter` renders the canonical prior Assistant
  Directive followed by `ariadne.agent-effect-results.v3` user transport.
- The exact model boundary rejects Provider-native Tool roles/calls and never
  falls back to a Provider-specific Tool protocol.
- Production-pipeline integration tests execute a real second model Turn after
  one durable Effect batch and verify canonical request bytes and identities.
- Default application composition provides the trusted Catalog and wires the
  production pipeline. Real Provider and real-window Tool continuation remain
  acceptance gates.

## Verification

Required tests cover digest sensitivity to `toolCallId`, orphan and duplicate
results, multi-Tool ordering, cross-batch interleaving, failed and cancelled
results, bounded payloads, secret absence from logs and projection, exact
text-only requests for every supported transport, rejection of native Tool
calls, and a real second model Turn after a committed Effect batch.
