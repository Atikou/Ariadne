# ADR 0024: durable Conversation session lifecycle

- Status: accepted and implemented
- Date: 2026-08-29
- Scope: Conversation title, archive/restore, projection and Renderer navigation

## Context

Conversation Message and Handoff were durable, but Session title and archive state
were owned by Renderer `localStorage`. Runtime therefore projected a fixed title
and active state. A restart, another window or another client could observe a
different lifecycle from the UI that performed the action. Device-local pin and
unread preferences were incorrectly mixed with durable business state.

Reading only the current Session row while replaying an older Conversation event
was also insufficient: a later rename could make an earlier event appear to have
the new title. Replay needs the exact Session version committed by each event.

## Decision

Conversation Authority is the sole owner of Session title and status. The public
contract exposes versioned create, rename, archive and restore commands. Every
mutation carries exact Session and Workspace identity plus
`expectedSessionVersion`; no-op mutations and stale CAS attempts fail closed.

Each accepted mutation commits one immutable `conversation.session.updated`
event, command receipt and Session version in the same SQLite transaction. The
`conversation_session_versions` table is append-only and supplies the exact
Session record used by event replay and Public Projection. Schema v3 migrates
existing Sessions and historical event versions to the legacy-equivalent
`Conversation`/`active` state.

Archived Sessions reject new user Messages. An Agent result that was already in
flight may still settle so archive does not strand a durable Run or Handoff.
Restore advances the same authority version and re-enables new input.

Renderer consumes title/status only from Public Projection. Its navigation
storage schema retains device-local pin and unread preferences, and migration
discards stale locally owned title/archive data. Settings restores archived
Sessions through the same public CAS command; no component writes a second
Session lifecycle authority.

## Consequences

- Rename and archive/restore converge across restart, windows and clients through
  the existing projection stream.
- Replaying an old accepted-message command returns its exact historical Session
  version rather than the current mutable head.
- Pin and unread remain intentionally device-local and do not affect Runtime.
- Durable fork/lineage, full-text search and bounded event query remain separate
  work. A future index must be rebuildable from Conversation authority.

## Verification

Required coverage includes protocol validation, create/rename/archive/restore
CAS and replay, archived-message rejection, immutable Session-version migration,
exact historical projection, Renderer local-state migration, RuntimeStore command
routing, full Runtime tests, type checks, architecture gates and real Electron UI
rename/archive/restore.
