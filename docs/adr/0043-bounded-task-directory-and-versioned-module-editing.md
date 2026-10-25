# ADR 0043: Bounded task directories and versioned module editing

Status: Accepted, 2026-10-06. T09A scoped module acceptance complete.

Agent Status consumes the existing bounded global and selected-session Run
catalogs. The repository owns pagination, generation and stale selection
rejection. The module never scans detail records to invent a complete catalog
or reads protected objectives for row titles. Publisher placeholders use a
public stable ID suffix; collisions within the page retain the full identity.
Custom public titles remain intact. Rows show actual session, status and time.
Opening a row selects its owning session and exact Run unless a later selection
owns the view. Counts and partial coverage remain authoritative.

Directory and detail share a bounded container with separate scrolling. Empty
details follow the list without an expanding gap. Long titles use two visible
lines and a full accessible title. Cancellation, recovery, budgets and child
controls retain their owners. Plan pagination uses the selected-session catalog;
unknown counts remain loading. Permissions label listing and detail scopes.

Memory editing captures entity identity and revision. Refresh updates server
data without remounting dirty fields. Conflicts require explicit reload or
adoption of the current revision before CAS. Deletion preserves copyable text
and blocks writes instead of silently creating a replacement. The shared draft
hook owns presentation state only. Delivery views reuse immutable receipt
references when source and draft links are unchanged to isolate subscribers.

Dockview 7.0.2 listener disposal omitted its resize debounce timer. The timer
and disposed state now share the listener lifecycle. The repository installation
script checks exact original hashes of four published entries, validates all
before changing any, and recognizes an identical repair on repeated runs.
Root postinstall and App prebuild enforce it. Unexpected versions or files
fail for reassessment. Remove the repair when the locked upstream implementation
owns pending callbacks. Exceptions are not swallowed; Renderer errors fail UI
acceptance. Tests exercise the actual published helper and immediate popout close.

Acceptance distinguishes presentation fixtures, actual SQLite pagination,
Source navigation and visible pixels. Mounted offscreen modules do not qualify
as screenshot acceptance. Native checks require both horizontal bounds and
visibility in the actual viewport.
Module-menu navigation activates the requested panel and expands a clipped grid
group. Switching groups leaves the previous maximized view. Restored panels receive
current module constraints at construction because Dockview's panel setter does
not replace constructor constraints. The cold-restore check retains persisted
panel identity while replacing stale widths. Native checks use ordinary module
navigation, then restore the original module, selected session and window bounds.

Final acceptance and retained failures: [remediation verification](../remediation-verification.md).
