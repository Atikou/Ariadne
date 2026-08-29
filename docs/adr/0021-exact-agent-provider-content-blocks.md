# ADR 0021: exact Agent Provider response content blocks

- Status: accepted and implemented
- Date: 2026-08-29
- Scope: exact Agent inference response, native Tool calls, replay evidence and usage

## Context

The previous exact boundary assembled only text and reasoning while reducing
Provider-native Tool calls to a count. The Engine then rejected every nonzero
count, so the advertised Tool Catalog and the actual Provider request were not
the same capability surface. Finish reason, cache dimensions and response
replay evidence also did not cross the succeeded Attempt boundary.

Adding Provider-specific branches to the Engine would create multiple final
content authorities. The fix is one Provider-neutral response contract between
wire adapters and Agent execution.

## Decision

### Provider-neutral response blocks

Every completed exact response contains an ordered, bounded block sequence:

```ts
type ExactAgentModelInferenceContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      providerToolName: string;
      input: AgentToolJsonValue;
    };
```

OpenAI-compatible and Anthropic adapters decode wire events but do not build a
second final response. `ExactAgentInferenceContentAssembler` is the only block
assembler. It preserves block order, bounds content/count/arguments, hashes raw
Provider call identities, and accepts Tool input only as a complete JSON object.
Conflicting identity/name fragments, duplicate calls, ambiguous or truncated
JSON, and finish/content contradictions fail closed.

### Native Tool projection

The immutable Ariadne Tool Catalog is projected into Provider Tool schemas on
every exact request. Provider-visible names are deterministic aliases, not
authorization identities. After assembly the Engine resolves each alias back
to the prepared immutable Tool identity, validates the wrapper input and scope,
and emits the same `AgentDirective` used by the Effect Ledger and Policy path.
Native Tool calls cannot dispatch directly from the transport.

Text-only final answers continue to use the strict
`ariadne.agent-directive.v3` response envelope. A response cannot mix executable
Tool blocks with non-whitespace text.

### Durable response evidence and usage

The succeeded Attempt atomically stores a sanitized response envelope containing
the exact provider/model/settings, adapter, normalized finish reason, request
digest, content-block digest/type sequence and optional hashed Provider response
identity. Raw Provider ids, reasoning and Tool arguments remain protected and
are not copied to Public Projection.

Usage input dimensions are disjoint:

```text
providerContextInput = inputTokens + cacheReadInputTokens + cacheWriteInputTokens
```

OpenAI aggregate prompt usage is normalized by subtracting cached tokens;
Anthropic's separate fields are preserved. Invalid or contradictory counts fail
closed. Long-context correction uses `providerContextInput`, not one partial
dimension.

## Consequences

- Native Tool calling and text responses share one Agent Directive authority.
- Finish and replay consistency are recoverable with the exact Attempt.
- Public running chunks remain presentation-only; terminal content still comes
  from the committed Directive.
- ADR-0022 now projects historical Tool exchanges as typed Assistant
  Tool-call/Tool-result request blocks. Reusable adapter-private replay state
  and durable attachments remain future work.

## Verification

Required coverage includes fragmented OpenAI and Anthropic Tool calls, multiple
and interleaved blocks, malformed/conflicting/truncated inputs, finish mismatch,
unknown Tool aliases, exact Tool schema serialization, cache normalization,
response-envelope atomic commit, full Runtime tests and repository gates.
