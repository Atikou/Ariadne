# ADR-0012: Sanitized and reviewable Decision presentation

- Status: Accepted
- Date: 2026-08-01

## Current implementation status (2026-08-26)

The v3 Decision write route and Renderer action path are active. Legacy public
`permissions.respond/resume` and `planHandoffs.respond/resume` commands are
removed. Authorized Effect dispatch and causal Continuation are connected by
the default production pipeline. Real-window allow/deny and restart acceptance
remain separate gates.

## Context

Public Projection v3 previously reduced every permission and Plan Decision to
a generic sentence. The Runtime held the exact Tool, capabilities, resource
scope, and protected Plan version, but Renderer received none of those review
facts. Exposing an opaque write credential beside that generic sentence would
allow uninformed approval.

Copying Effect input, Plan payloads, Provider identities, paths, or recovery
evidence into the public stream is not an acceptable remedy. Those values are
private authority or protected execution data.

## Decision

Every public Decision carries a strict, versioned, kind-matched
`presentation`. Root-level free-form `title` and `summary` fields are removed.

Permission presentation is derived only from the exact intended Effect bound
to the active Decision. It exposes:

- the pinned public Tool name, but no Provider, catalog, version, digest,
  input, or idempotency identity;
- the complete canonical capability ID list;
- the complete canonical resource-scope ID list and an explicit summary for an
  empty or narrowed scope.

Plan presentation is never inferred from an arbitrary Plan payload. The exact
protected Plan version must pass its content-hash check and contain a strict
`publicPresentation` v1 fragment with one to 32 bounded review steps, a bounded
summary, and an impact summary. The public approval scope is fixed to
`continue_run_with_presented_plan`. Extra fields inside the protected Plan stay
private; extra fields inside the public fragment are rejected.

Recovery presentation remains generic and never includes uncertainty evidence.
The public boundary continues to reject absolute paths and credential-shaped
text after schema validation.

Renderer `ProjectionCache` retains the exact opaque action descriptor as
transport authority, but presenters and React-facing view models never copy
its token into displayed state, logs, labels, or text. Permission and Plan
actions set `actionAvailable=true` only for an active, kind-matched descriptor
with the exact allowed choices and displayed authorization semantics. At click
time `RuntimeStore` rereads the exact cached Decision and sends
`agent.decision.resolve.v3`; any missing or mismatched descriptor fails closed
and leaves the action disabled.

## Consequences

- An incomplete or unhashable Plan presentation stops Projection before append
  and ACK; it cannot silently fall back to a generic approval card.
- Capability and scope lists are bounded but never truncated. A Decision that
  cannot be shown completely fails closed.
- `DefaultAgentControlRuntimeFactory` now supplies the exact protected
  Plan-version reader used by production Plan projection. Missing, drifted, or
  unhashable Plan material still fails closed before append/ACK instead of
  presenting an uninformed action.
- Terminal Decision history retains the same review presentation without
  retaining an action descriptor.

## Verification

Protocol tests cover strict kind matching, sorted identifiers, bounded Plan
steps, extra-field rejection, and terminal action removal. Runtime tests cover
exact Effect projection, protected Plan hash/presentation extraction, private
field exclusion, and failure before append/ACK when the public Plan fragment is
missing. Renderer tests cover complete permission and Plan mapping, exact
enablement/disablement, v3 Decision routing, and absence of the action
credential from presented/rendered state.
