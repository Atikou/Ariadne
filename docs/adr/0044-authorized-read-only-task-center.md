# ADR 0044: Authorized read-only task center

Status: Accepted, 2026-10-06. The scoped T10 implementation and acceptance are complete;
the physical Windows notification acceptance tracked under T04 remains open.

The task center reads Run/Decision Projection, Conversation ownership and the
existing Productivity authority. It owns no executable task, command receipt or
business transition. Source type and ID form its identity; Goal, Workflow,
Schedule definition, occurrence and Run remain distinct linked records. Schedule
submission and Run completion are separate facts. Public list metadata excludes
prompts, criteria, tool bodies and decision action tokens.

Runtime owns the authorized aggregation and filtering. Renderer receives bounded
pages and retains filters, position and selection. Productivity adds a versioned
read extension under its existing database owner; the nine frozen access ports
and business schemas stay unchanged. Derived SQLite snapshots/indexes may be
rebuilt and must never write authoritative task state. Reads yield between bounded
source batches so building the directory cannot monopolize the command owner.

A page belongs to an immutable query snapshot, exact authorization/filter scope
and stable ordering. Updates invalidate or refresh coverage explicitly; expired
cursors require a new snapshot. Source watermarks describe eventual consistency
across databases, with unavailable or still-building sources exposed as partial
coverage. A refresh includes changes that occurred while the prior page was open.
Counts describe the indexed snapshot, not an invented global execution total.

Navigation revalidates stable source/session identity and displayed version.
Missing, archived, unauthorized, stale and unavailable references have explicit
outcomes. Result navigation uses authorized immutable Conversation references;
uncommitted results remain pending. Waiting tasks open the original Decision UI;
cancel/retry/recovery remain with their existing versioned command owners. The
center does not silently issue a mutation against a newer unseen source version.

Completion/failure notification preference reuses Main's production reminder
facts and deduplication owner. Historic terminal rows do not replay on opening the
directory or restarting. Physical notification acceptance remains a separate gate.

The formal desktop profiles include `tasks.center` at revision 6. Both extension
read ports have independent V1 baselines: `ProductivityTaskCatalogReadV1` and
`ConversationMessageIdentityReadV1`. The original frozen ports are unchanged.
The derived task-query owner provides a five-minute immutable snapshot, at most
16 retained snapshots, 128 rows/2 MiB per transport page and an authorization-
and-filter-bound HMAC cursor including the first page. Renderer retains one
directory page, one selected metadata record and at most 32 previous positions.
`tasks.relations` rechecks source version/attempt/status on both sides of an
authorized, bounded association read; its raw source total is distinct from the
count of verified accessible Runs. Unknown derived schemas/triggers are retained,
not erased as a rebuild.

Terminal reminders are another input to the existing
`ApprovalNotificationService`, sharing its coalesced wake, background/game policy
and three-display budget. Only actual terminal Core Runs qualify; completed Runs
need a verified result reference. Main reads metadata pages without result bodies
and revalidates exact Run ownership/version before display and activation. Native
shown events alone establish delivery. `notification-delivery.db` is a Main-owned
SQLite display index, with persisted preference enabling boundaries and delivery
receipts. It stores no business task state or protected body; count/age eviction
cannot replay earlier delivery. A first enable/re-enable excludes earlier terminal
history; an enabled preference and observed receipts survive Main restarts. An
unknown/damaged delivery index is preserved and pauses terminal reminders while
the original approval notification consumer continues. This index must be included
in T11 same-machine backup/restore alongside the existing decision receipt file.

Windows launch data has a separate validated `ariadne-task:v1:` namespace and
`ariadne.task` group. The single Main activation path re-reads the authorized
original task and sends only a validated navigation target through the existing
notification navigation channel. The application root receives task navigation
even when the chat module is closed; original Feature Stores load the exact
Run/Decision/message window. User questions open the original chat approval card,
permissions the original permission module, and plans the original plan module.
Cards focus only when visible and scroll inside their owning module container.

Acceptance must cover cross-workspace authorization, parent/child and
Goal/Workflow/occurrence/Run links, partial failures, cancellation, permissions,
pending results, archives, continuous updates during pagination, stale navigation,
reload and actual Electron UI. Unit/build success alone does not accept T10.

The final production Electron gate retained 70 deterministic Provider requests,
66 responses, four expected aborts, five Runtime kills, Main restart and oversized
Run recovery. Source directory, immutable result navigation, permission/question
focus and 1000/1600 layouts passed. The native lifecycle gate also verified the
original permission and plan cards, actual completed/failed Core transitions and
native shown callbacks. A clean Main reopen on that same isolated directory
verified all four terminal Core versions and unchanged enabling windows/delivery
receipts after 35 seconds in the background. This establishes restart deduplication,
not a physical toast click or an active-game detector test. Runtime's actual SQLite
joins and authorization tests, App tests, 229 Renderer interactions, types and
architecture checks are recorded in `docs/remediation-verification.md`.
