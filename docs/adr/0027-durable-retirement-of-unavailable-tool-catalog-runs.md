# ADR 0027: durable retirement of unavailable Tool Catalog Runs

- Status: accepted and implemented
- Date: 2026-08-29
- Scope: nonterminal Agent Runs pinned to an executable Catalog no longer shipped after upgrade

## Context

ADR-0010 pins every Run to one exact immutable Tool Catalog and ADR-0026
binds that Catalog to actual built implementation bytes. Production ships only
the current executable Catalog snapshot. After an upgrade, a nonterminal Run
pinned to an older snapshot therefore cannot execute safely.

The previous scheduler treated every missing exact Catalog as an infrastructure
exception. That prevented silent rebinding, but one retired Run latched the
whole work scheduler unhealthy and blocked unrelated Runs. It also provided no
durable product result for the affected Conversation.

Pretending the current callbacks implement the old revision would violate the
Run's immutable authority. Retaining arbitrary historical callbacks in memory
would not survive packaging or process restart.

## Decision

The production authority verifier now returns one explicit
`retired_tool_catalog` assessment only when the exact pinned Catalog snapshot is
absent. Missing model bindings, SubAgent Provider catalogs, binding drift and
Effect Tool drift remain health errors; they are not converted into retirement.

At startup the work scheduler performs an authority migration before any fresh
Provider or Tool I/O:

1. every persisted started Effect or inference is first converted to its
   existing durable uncertain-recovery fact;
2. already committed projection outbox is drained before the migration, closing
   the crash window between a Child terminal event and Parent observation;
3. retired Runs are ordered Child-before-Parent;
4. each Run commits a deterministic `run.fail` command with
   `agent_tool_catalog_retired` and an
   `execution_authority_terminalized/tool_catalog_retired` checkpoint;
5. a delegated Child terminal is immediately sent through the same canonical
   Child-terminal observer used by Public Projection, which releases delegated
   budget and advances the Parent version;
6. optimistic Parent version conflicts cause a full rescan before retirement
   continues.

The migration performs no Provider or Tool I/O and never substitutes the
current Catalog. Other restorable Runs proceed after the retired Run reaches a
durable terminal state. The public failure message tells the user to start a new
Run under the current Catalog without exposing protected inputs or credentials.

## Consequences

- A retired pin no longer prevents Runtime readiness or unrelated Agent work.
- Started-work uncertainty, Child/Parent settlement, delegated budget release,
  checkpoints, outbox events and Conversation terminal projection keep their
  existing single owners.
- Public Projection replay is idempotent because migration and projection use
  the same stable Child-terminal observation command.
- Old Runs are deliberately not resumed with new code. Ariadne's current
  cross-version policy is durable retirement, not historical executable bundle
  retention. A product that promises exact continuation across binary upgrades
  would still need bounded signed historical bundles and a support window.
- Corrupt or incomplete recovery material remains a startup health failure and
  is never hidden by the retirement path.

## Verification

Required coverage includes an exact missing-Catalog upgrade over SQLite, no
Provider/Tool call, durable failure code and checkpoint, an unrelated current
Run continuing, started work settling before retirement, Child-before-Parent
ordering with version rescan, canonical Child terminal observation, delegated
budget release, projection replay, architecture boundaries and real Electron
startup.
