# ADR-0015: Historical pure-v3 text Effect-result protocol

- Status: Superseded by ADR-0022
- Date: 2026-08-01
- Superseded: 2026-08-29

## Historical decision

This ADR introduced the protected `effect_result` Turn-input variant and the
canonical `ariadne.agent-effect-results.v3` text projection. The protected
Turn-input decision remains active: one result batch is bound to the exact
prior Directive, Effect identities and Tool-call identities, and its protected
payload is never copied to Public Projection.

The text request projection and the requirement to reject Provider-native Tool
calls are both historical. ADR-0021 replaced the response side; ADR-0022
replaced committed Tool history with Provider-neutral request blocks.

## Retained storage boundary

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

This union is a protected execution snapshot, not the Provider request shape.
The Engine validates the source Directive, ordering, identities and result
state, then resolves raw Tool input from the digest-bound protected Effect
payload. Exact adapters serialize the resulting typed Tool-call/result blocks
to each Provider's native history format. No text fallback remains.

## Verification retained

Tests continue to cover digest sensitivity, orphan/duplicate/cross-batch
rejection, result ordering, bounded payloads, protected storage, and a second
model Turn after a committed Effect batch. Native response verification is
owned by ADR-0021; typed request history is owned by ADR-0022.
