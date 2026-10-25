# ADR 0042: Versioned productivity editing

Status: Accepted, 2026-10-06. T09 scoped acceptance complete.

Productivity remains the single authority for goals, Todos, workflows and
schedules. Renderer editing uses the existing goal.put and todo.snapshot.replace
commands. No new execution state, persistence schema or frozen public access
contract is introduced.

Goal and autonomy configuration drafts capture a server revision. Refreshes
update visible progress, but retain dirty fields against their original
baseline. A changed revision shows server differences and blocks submission
until the user explicitly reloads or keeps input against the current revision.
Rejected commands retain input. Acknowledged mutations update only their
confirmed view; failure to fetch afterward is a read error, not task failure.
Receipt acknowledgement is labelled submitted, never completed execution.

Todo editing and deletion capture both Goal version and Todo revision. A single
replacement atomically preserves the other items. Deleting a predecessor lists
the affected tasks; its edges are removed only after an explicit choice in the
same command. Authority validation rejects self edges, duplicates, missing
nodes and cycles. Every active, pending and resolved task referenced by a
running/cancelling workflow stays frozen until that workflow ends. The UI shows
this restriction and the authority still enforces it against races.

The main view leads with goal progress, task faults, Todos and actual workflow
results. Goal parameters, autonomy criteria/limits and schedule management are
expandable. User-facing status labels describe business state; version and
phase remain available in diagnostic details. Existing ModalSurface owns
focus containment, Escape and focus restoration. Existing SelectMenu and theme
tokens are reused.

Acceptance must separately verify actual authority CAS/graph/frozen-task
constraints, production React component refresh races and keyboard/narrow
layouts, and the full emitted Electron/Agent path. Explicit deferred-service
fixtures do not replace production persistence or Provider evidence. Current
targeted authority tests pass 3 files/38 tests. Scoped production-component
fixtures pass 58 checks including trusted keyboard events; App 95/440 and
node/web/test/TSX-fixture types/build, architecture and frozen contracts pass.
Final emitted Electron/Agent/editing and Main restart pass, including actual
SQLite CAS, cycle rejection without mutation, dependency-preserving editing and
explicit predecessor removal. Original 70/66/4 fixture trace and five Runtime
kills remain. These are deterministic Provider fixtures, not model-quality
acceptance. Earlier failures and screenshot capture limits are retained in
remediation-verification.md and artifacts/todo-remediation.
