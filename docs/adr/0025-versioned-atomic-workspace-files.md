# ADR 0025: versioned atomic workspace files

- Status: accepted and implemented for whole-file read/write
- Date: 2026-08-29
- Scope: production v3 `workspace.read_file` and `workspace.write_file`

## Context

The production Tool Catalog previously read a workspace file with `readFile`
and later approved a complete replacement with `writeFile`. A user or another
process could change the file between those calls and the approved Agent write
would silently destroy the newer content. The write also published bytes in
place, so observers could see a partial file if the process failed mid-write.

The legacy Tool registry contained hash checks and temporary-file replacement,
but it is not the production v3 authority. Reconnecting it would create a second
Tool path and preserve the wrong ownership boundary.

## Decision

`LocalWorkspaceFileService` is the sole production owner of complete UTF-8 file
observation, freshness validation and publication. The control port exposes an
opaque `WorkspaceFileVersion`; callers compare or return it but never parse it.
The local adapter derives it from content digest plus high-resolution file
identity and freshness metadata after a stable bounded read.

`workspace.read_file` v2 returns that version. `workspace.write_file` v2 accepts
exactly one guarded intent:

- `create_if_absent` publishes only when the target does not exist;
- `replace_if_version` requires the exact version returned by a prior read.

There is no unconditional overwrite arm and no compatibility default. Missing,
deleted or changed replacement targets fail with stable machine-routable error
codes. The Tool still applies workspace permission, scope and path-containment
checks before calling the service; an existing final-component symlink is
rejected at that boundary.

Writes use a fully written and synced temporary file in the target directory.
Create uses a no-replace hard-link publication and replacement revalidates the
version immediately before same-directory atomic rename. Service-owned writes
to the same target are serialized, so two replacements from one observation
cannot both commit. Cancellation is checked before publication; after publish,
the operation reconciles and reports the actual resulting version rather than
pretending a completed effect was cancelled.

This adapts the useful provider-owned version/guard semantics from DeepSeek
Harness without importing its optional plugin event system. Ariadne's immutable
Tool Catalog keeps the guard explicit in the v2 Tool contract instead of adding
hidden per-session observation state or another runtime authority.

## Consequences

- Approval no longer authorizes a blind overwrite of content changed since the
  Agent observed it.
- New-file creation cannot replace an existing file and is never partially
  visible through the final path.
- Catalog revision 13 pins the v2 read/write contracts and their new artifact
  identities. A persisted run pinned to an unavailable older catalog fails
  closed after upgrade; it is never silently rebound to v2.
- Whole-file writes remain bounded to 256 KiB. Structured edit/patch/search and
  diff render intent remain separate work and must reuse this service policy.
- An uncooperative external writer can still race in the platform-level interval
  between the final validation syscall and atomic rename; the service guarantees
  serialization for its own provider and minimizes that interval without
  claiming a kernel conditional-rename primitive that Node does not expose.

## Verification

Required coverage includes guarded create, exact replacement, external stale
edit, deletion, two concurrent replacements, cancellation, temporary-artifact
cleanup, v2 Tool normalization, stable error codes, catalog digest/revision,
architecture limits and real Electron read/create behavior.
