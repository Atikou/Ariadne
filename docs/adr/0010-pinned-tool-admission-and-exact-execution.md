# ADR-0010: Pinned tool admission and exact prepared execution

- Status: Accepted
- Date: 2026-07-31

## Context

The legacy tool path resolves a tool by name at execution time. Providers can
be replaced while a Run is active, and the old Turn descriptor contains only
a name and capability strings. The model can therefore see one contract while
execution uses another version, Provider, Schema, or normalizer.

The legacy Registry also normalizes input immediately before execution. If
admission normalized and hashed an earlier value, the executed value can differ
from the committed `inputDigest`. Dynamic permission resolution can fall back
to a weaker base permission after an exception, and path checking can skip an
unknown tool shape. These are fail-open and TOCTOU boundaries.

## Decision

### Immutable catalog snapshots

Every admitted Run references an immutable Tool Catalog snapshot by
`catalogId + revision + digest`. Its canonically sorted entries include:

- tool name and version;
- Provider identity and immutable Provider/contract digest;
- canonical input and output Schema;
- capabilities, resource scopes, effects, risk, egress, idempotency, and other
  safety metadata needed to reproduce admission.

Provider updates create a new catalog revision. They never mutate a snapshot
still referenced by a Run. MCP or other dynamic tools must change their
contract digest when Schema or safety metadata changes, even if their display
version remains the same.

Turn descriptors, model Directives, committed invocations, and Effects share
one exact pinned identity value object:

```ts
interface AgentPinnedToolIdentity {
  catalogId: string;
  revision: number;
  digest: `sha256:${string}`;
  toolName: string;
  toolVersion: string;
  providerId: string;
  contractDigest: `sha256:${string}`;
}
```

The catalog reference must equal the Run binding. Execution never falls back
from this identity to a current tool with the same name.

### Pure Core admission Port

Agent Core owns a pure `AgentToolAdmissionPolicy` Port. It receives the exact
Run, Turn, Attempt, pinned descriptor, requested capabilities and scopes, and
bounded JSON input. Runtime implements the Port using the immutable catalog,
workspace grant, Tool contract, Schema, and policy authorities.

The decision is `allow`, `wait`, or `deny`. An allow/wait result contains only
the pinned identity, canonical capability/scope values, and normalized
data-only JSON. Runtime error details, raw paths, Zod issues, and original input
do not enter Run, Event, Outbox, or receipt payloads.

`permissionMode=ask` cannot become allow. A Runtime policy may narrow a Run
grant but never expand it. In a multi-tool Directive, any deny or wait rejects
the complete batch until multi-decision semantics are explicitly designed;
no partial Effect or recovery payload is committed.

Core hashes the admitted normalized input and atomically commits the Effect and
its protected recovery payload with the inference result. Infrastructure
failure while proving catalog or policy identity is not converted into a
deterministic model error; the inference attempt becomes uncertain/recovering.

### Prepare once, execute exactly

The production tool platform exposes two distinct operations:

```text
prepareExact(pinnedIdentity, rawInput, immutableRunGrant)
  -> resolve exact contract
  -> normalize once
  -> validate Schema, capabilities, scopes, workspace, and policy
  -> return canonical normalized input

executePreparedExact(pinnedIdentity, normalizedInput, committedGrant)
  -> resolve the same exact contract
  -> validate Schema again
  -> require canonical equality with normalized input
  -> execute without calling normalizeInput
```

The Effect dispatcher calls only `executePreparedExact`. It supplies the
committed catalog, workspace, permission, scope, Effect, and idempotency
identities. Mutable context objects and spreadable `registryExtras` are not an
authority input.

Permission or scope resolvers that throw, return an invalid result, or cannot
describe a declared workspace resource deny admission. Traversal, junction or
symlink escape, workspace mismatch, catalog drift, Provider drift, and contract
drift fail closed before tool I/O.

## Consequences

- The new Agent Control path cannot call legacy `ToolRegistry.run(name,
  rawInput)` or use it as fallback.
- Tool Catalog snapshots require their own authoritative persistence and
  owner/lifecycle boundary, created once by Composition and shared by admission
  and execution.
- Historical Agent loops and registries are not valid production fallbacks.
- Production routing must fail closed if exact Catalog, authority, executor,
  recovery or composition health checks are unavailable.

## Current implementation status (2026-08-29)

The Core contract and the trusted offline Runtime catalog foundation are
implemented:

- `AgentRunBinding` v3 pins the catalog, allowed Tool names, capabilities,
  workspace scopes, and durable budget grant.
- Directives, admission decisions, committed Effects, and the executor carry
  the same complete `AgentPinnedToolIdentity`.
- `AgentToolContractDocumentV1` is the data-only authority for identity,
  canonical input/output Schema, capability and workspace requirements,
  approval/permission, scope/resource semantics, side effects, idempotency,
  recovery, timeout, and Provider/normalizer/validator/executor artifacts.
- `compileTrustedAgentToolCatalog` canonicalizes and hashes each complete
  contract document, verifies the declared SHA-256 values from supplied
  implementation artifact bytes (never `Function.toString()`), sorts entries
  by `toolName`, and derives the catalog digest. Neither a contract digest nor
  a final pinned Tool identity is accepted as registration input.
- ADR-0026 replaces the former synthetic name/version artifact bytes with a
  build-generated, runtime-reverified closure of the actual emitted JavaScript
  modules for every production Tool root.
- `ImmutableAgentToolCatalog` accepts only the compiler-branded immutable
  snapshot binding document, derived pin, and captured callbacks. It has no
  direct executable-array constructor, self-reported digest, replace-by-name,
  or name fallback path.
- Admission owns the one normalization step. Execution calls the separate
  prepared-input validator, requires canonical equality, and never invokes the
  normalizer again.
- Admission and execution clone all caller authority before invoking Tool code;
  prepared validation cannot mutate the durable input, and Tool I/O receives a
  deeply frozen input and frozen capability/scope context. An already-aborted
  signal returns a deterministic cancellation before validation or Tool I/O.
- The default `ProductionAgentControlExecutionPipelineFactory` constructs one
  compiler-verified immutable Catalog registry per Runtime,
  preflights every enabled authority against its exact Catalog, and shares that
  registry with admission and initial Inference contract projection. Admission
  also gates the exact Model/Credential binding before a new Message write.
- `ProductionAgentEffectExecutionInputReader`, the bounded checkpoint factory,
  Effect scheduler and causal Continuation use the same exact Catalog owner.
- Real-window Tool/Decision/restart acceptance remains a release gate. ADR-0027
  chooses durable retirement for a no-longer-shipped Catalog; authorities never
  reconstruct a snapshot from persisted final digests alone.

## Verification

Required tests cover catalog/provider/version/contract drift, capability and
scope expansion, read-to-write escalation, traversal and symlink escape, Zod
coercion/default/strip behavior, invalid JSON-like normalizer outputs,
permission resolver exceptions, ask/trusted decisions, atomic multi-tool
failure, process loss before and after commit, old Runs after catalog updates,
exactly one normalizer call, no name fallback, no tool I/O on drift, and zero
architecture dependency violations.
