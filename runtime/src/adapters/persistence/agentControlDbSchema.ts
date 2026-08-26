import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

/**
 * Independent schema and serialized-ledger format for agent-control.db.
 *
 * Schema version 5 materializes Agent v3 ledger revision 49. It adds the
 * protected per-Turn execution snapshot to the multi-Run command ledger. Every
 * older store requires an explicit offline migration; Runtime never mutates,
 * dual-writes, or reinterprets it during startup.
 */
export const AGENT_CONTROL_DB_SCHEMA_VERSION = 5;

/** Domain ledger revision materialized by schema version 5. */
export const AGENT_CONTROL_LEDGER_REVISION = 49;

export const AGENT_CONTROL_METADATA_KEYS = {
  activeKeyId: 'active_key_id',
  keyringGeneration: 'keyring_generation'
} as const;

export const AGENT_CONTROL_DB_RELATIVE_PATH = path.join(
  'data',
  'agent-control',
  'agent-control.db'
);

export interface AgentControlDbMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync) => void;
}

export const AGENT_CONTROL_DB_MIGRATIONS: readonly AgentControlDbMigration[] = [
  {
    version: 4,
    name: 'agent_control_v3_execution_intent_ledger',
    up: createAgentControlSchemaV4
  },
  {
    version: 5,
    name: 'agent_control_v3_protected_turn_inputs',
    up: addAgentControlSchemaV5
  }
];
interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export function resolveAgentControlDatabasePath(dataRoot: string): string {
  if (typeof dataRoot !== 'string' || dataRoot.trim().length === 0) {
    throw new Error('agent_control_data_root_required');
  }
  return path.resolve(dataRoot, AGENT_CONTROL_DB_RELATIVE_PATH);
}

/**
 * Opens the sole Agent Control store and initializes only a pristine database.
 * Unknown, older, newer, or structurally divergent stores fail closed.
 */
export function openAgentControlDatabase(dataRoot: string): {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly ownerLease: SqliteOwnerLease;
} {
  const databasePath = resolveAgentControlDatabasePath(dataRoot);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const ownerLease = acquireSqliteOwnerLease(databasePath, 'agent-control');
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 0;');
    initializeOrValidateSchema(database);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    assertAgentControlDatabasePragmas(database);
    return { database, databasePath, ownerLease };
  } catch (error) {
    if (database !== null) {
      try {
        closeOwnedSqliteDatabase(database, ownerLease);
      } catch {
        // Preserve the schema/open error. An uncertain business close keeps
        // the owner fence alive until process exit.
      }
    } else {
      ownerLease.close();
    }
    throw error;
  }
}

function assertAgentControlDatabasePragmas(database: DatabaseSync): void {
  const foreignKeys = database.prepare('PRAGMA foreign_keys;').get() as {
    foreign_keys: number;
  };
  const busyTimeout = database.prepare('PRAGMA busy_timeout;').get() as {
    timeout: number;
  };
  const journalMode = database.prepare('PRAGMA journal_mode;').get() as {
    journal_mode: string;
  };
  const synchronous = database.prepare('PRAGMA synchronous;').get() as {
    synchronous: number;
  };
  if (
    Number(foreignKeys.foreign_keys) !== 1
    || Number(busyTimeout.timeout) !== 0
    || journalMode.journal_mode.toLowerCase() !== 'wal'
    || Number(synchronous.synchronous) !== 2
  ) {
    throw new Error('agent_control_pragma_verification_failed');
  }
}

function initializeOrValidateSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version > AGENT_CONTROL_DB_SCHEMA_VERSION) {
    throw new Error(
      `agent_control_schema_newer_than_runtime:${String(version)}:`
      + String(AGENT_CONTROL_DB_SCHEMA_VERSION)
    );
  }
  if (version > 0 && version < AGENT_CONTROL_DB_SCHEMA_VERSION) {
    throw new Error(
      `agent_control_offline_migration_required:agent_control_schema:`
      + `${String(version)}:`
      + String(AGENT_CONTROL_DB_SCHEMA_VERSION)
    );
  }
  if (version === 0) {
    const objects = listSchemaObjects(database);
    if (objects.length > 0) {
      throw new Error(
        `agent_control_unversioned_schema_not_empty:`
        + objects.map(schemaObjectIdentity).join(',')
      );
    }
    createSchema(database);
  }
  assertAgentControlSchema(database);
}

function createSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (
      AGENT_CONTROL_DB_MIGRATIONS.length !== 2
      || AGENT_CONTROL_DB_MIGRATIONS[0]?.version !== 4
      || AGENT_CONTROL_DB_MIGRATIONS[1]?.version !== AGENT_CONTROL_DB_SCHEMA_VERSION
    ) {
      throw new Error('agent_control_migration_definition_invalid');
    }
    for (const migration of AGENT_CONTROL_DB_MIGRATIONS) {
      migration.up(database);
      database.prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      ).run(migration.version, migration.name, new Date().toISOString());
    }
    database.exec(`PRAGMA user_version = ${AGENT_CONTROL_DB_SCHEMA_VERSION};`);
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function createAgentControlSchemaV4(database: DatabaseSync): void {
  database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE agent_control_metadata (
        key TEXT PRIMARY KEY CHECK(key IN ('keyring_generation', 'active_key_id')),
        value TEXT NOT NULL CHECK(length(value) > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_v3_runs (
        run_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version > 0),
        state_status TEXT NOT NULL CHECK(state_status IN (
          'queued', 'running', 'waiting', 'recovering',
          'waiting_children', 'cancelling',
          'completed', 'failed', 'cancelled'
        )),
        aggregate_json TEXT NOT NULL CHECK(
          json_valid(aggregate_json)
          AND COALESCE(json_type(aggregate_json, '$.turns') = 'array', 0)
          AND COALESCE(
            json_type(aggregate_json, '$.binding.toolCatalog') = 'object',
            0
          )
          AND COALESCE(
            json_type(aggregate_json, '$.binding.toolCatalog.catalogId') = 'text'
            AND length(json_extract(
              aggregate_json,
              '$.binding.toolCatalog.catalogId'
            )) > 0,
            0
          )
          AND COALESCE(
            json_type(aggregate_json, '$.binding.toolCatalog.revision') = 'integer'
            AND json_extract(
              aggregate_json,
              '$.binding.toolCatalog.revision'
            ) > 0,
            0
          )
          AND COALESCE(
            json_type(aggregate_json, '$.binding.toolCatalog.digest') = 'text'
            AND length(json_extract(
              aggregate_json,
              '$.binding.toolCatalog.digest'
            )) = 71
            AND substr(json_extract(
              aggregate_json,
              '$.binding.toolCatalog.digest'
            ), 1, 7) = 'sha256:'
            AND substr(json_extract(
              aggregate_json,
              '$.binding.toolCatalog.digest'
            ), 8) NOT GLOB '*[^0-9a-f]*',
            0
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agent_v3_runs_status
        ON agent_v3_runs(state_status, updated_at DESC);
      CREATE INDEX idx_agent_v3_runs_recovery
        ON agent_v3_runs(created_at, run_id)
        WHERE state_status IN (
          'queued', 'running', 'waiting', 'recovering',
          'waiting_children', 'cancelling'
        );

      CREATE TABLE agent_v3_commands (
        command_id TEXT PRIMARY KEY,
        command_digest TEXT NOT NULL CHECK(
          length(command_digest) = 71
          AND substr(command_digest, 1, 7) = 'sha256:'
        ),
        mutation_count INTEGER NOT NULL CHECK(mutation_count > 0),
        fact_count INTEGER NOT NULL DEFAULT 0 CHECK(fact_count >= 0),
        committed_at TEXT NOT NULL
      );

      CREATE TABLE agent_v3_command_runs (
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        expected_version INTEGER CHECK(
          expected_version IS NULL OR expected_version > 0
        ),
        resulting_version INTEGER NOT NULL CHECK(resulting_version > 0),
        result_run_json TEXT NOT NULL CHECK(
          json_valid(result_run_json)
          AND COALESCE(json_type(result_run_json, '$.turns') = 'array', 0)
          AND COALESCE(
            json_type(result_run_json, '$.binding.toolCatalog') = 'object',
            0
          )
          AND COALESCE(
            json_type(result_run_json, '$.binding.toolCatalog.catalogId') = 'text'
            AND length(json_extract(
              result_run_json,
              '$.binding.toolCatalog.catalogId'
            )) > 0,
            0
          )
          AND COALESCE(
            json_type(result_run_json, '$.binding.toolCatalog.revision') = 'integer'
            AND json_extract(
              result_run_json,
              '$.binding.toolCatalog.revision'
            ) > 0,
            0
          )
          AND COALESCE(
            json_type(result_run_json, '$.binding.toolCatalog.digest') = 'text'
            AND length(json_extract(
              result_run_json,
              '$.binding.toolCatalog.digest'
            )) = 71
            AND substr(json_extract(
              result_run_json,
              '$.binding.toolCatalog.digest'
            ), 1, 7) = 'sha256:'
            AND substr(json_extract(
              result_run_json,
              '$.binding.toolCatalog.digest'
            ), 8) NOT GLOB '*[^0-9a-f]*',
            0
          )
        ),
        PRIMARY KEY(command_id, run_id),
        FOREIGN KEY(command_id)
          REFERENCES agent_v3_commands(command_id) ON DELETE RESTRICT,
        FOREIGN KEY(run_id) REFERENCES agent_v3_runs(run_id) ON DELETE RESTRICT,
        UNIQUE(command_id, ordinal),
        UNIQUE(run_id, resulting_version)
      );
      CREATE INDEX idx_agent_v3_command_runs_history
        ON agent_v3_command_runs(run_id, resulting_version);
      CREATE UNIQUE INDEX idx_agent_v3_command_runs_identity
        ON agent_v3_command_runs(command_id, run_id, resulting_version);

      CREATE TABLE agent_v3_plan_versions (
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL CHECK(plan_version > 0),
        content_hash TEXT NOT NULL CHECK(
          length(content_hash) = 71
          AND substr(content_hash, 1, 7) = 'sha256:'
          AND substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        run_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        command_id TEXT NOT NULL,
        codec_id TEXT NOT NULL CHECK(length(codec_id) > 0),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(plan_id, plan_version),
        UNIQUE(plan_id, plan_version, content_hash),
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT
      );
      CREATE INDEX idx_agent_v3_plan_versions_run
        ON agent_v3_plan_versions(run_id, plan_id, plan_version);

      CREATE TABLE agent_v3_plan_approvals (
        approval_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL CHECK(checkpoint_version > 0),
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL CHECK(plan_version > 0),
        content_hash TEXT NOT NULL,
        command_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        approved_at TEXT NOT NULL,
        FOREIGN KEY(plan_id, plan_version, content_hash)
          REFERENCES agent_v3_plan_versions(plan_id, plan_version, content_hash)
          ON DELETE RESTRICT,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(run_id, checkpoint_version, plan_id, plan_version, content_hash)
      );
      CREATE INDEX idx_agent_v3_plan_approvals_run
        ON agent_v3_plan_approvals(run_id, checkpoint_version);

      CREATE TABLE agent_v3_budget_grants (
        grant_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        model_turns INTEGER NOT NULL CHECK(model_turns >= 0),
        tool_calls INTEGER NOT NULL CHECK(tool_calls >= 0),
        read_calls INTEGER NOT NULL CHECK(read_calls >= 0),
        write_calls INTEGER NOT NULL CHECK(write_calls >= 0),
        shell_calls INTEGER NOT NULL CHECK(shell_calls >= 0),
        cost_microusd INTEGER NOT NULL CHECK(cost_microusd >= 0),
        deadline_at TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('root', 'parent_allocation')),
        parent_run_id TEXT,
        parent_grant_id TEXT,
        delegation_id TEXT,
        command_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(parent_grant_id)
          REFERENCES agent_v3_budget_grants(grant_id) ON DELETE RESTRICT,
        CHECK(
          (source_kind = 'root' AND parent_run_id IS NULL
            AND parent_grant_id IS NULL AND delegation_id IS NULL)
          OR
          (source_kind = 'parent_allocation' AND parent_run_id IS NOT NULL
            AND parent_grant_id IS NOT NULL AND delegation_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_agent_v3_budget_grants_parent
        ON agent_v3_budget_grants(parent_grant_id, delegation_id);

      CREATE TABLE agent_v3_budget_entries (
        entry_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        grant_id TEXT NOT NULL,
        entry_kind TEXT NOT NULL CHECK(entry_kind IN (
          'root_grant', 'parent_allocation', 'reservation',
          'settlement', 'release', 'child_release'
        )),
        model_turns INTEGER NOT NULL CHECK(model_turns >= 0),
        tool_calls INTEGER NOT NULL CHECK(tool_calls >= 0),
        read_calls INTEGER NOT NULL CHECK(read_calls >= 0),
        write_calls INTEGER NOT NULL CHECK(write_calls >= 0),
        shell_calls INTEGER NOT NULL CHECK(shell_calls >= 0),
        cost_microusd INTEGER NOT NULL CHECK(cost_microusd >= 0),
        reservation_id TEXT,
        delegation_id TEXT,
        child_run_id TEXT,
        child_grant_id TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(grant_id)
          REFERENCES agent_v3_budget_grants(grant_id) ON DELETE RESTRICT,
        FOREIGN KEY(child_grant_id)
          REFERENCES agent_v3_budget_grants(grant_id) ON DELETE RESTRICT,
        CHECK(
          (entry_kind = 'root_grant' AND reservation_id IS NULL
            AND delegation_id IS NULL AND child_run_id IS NULL
            AND child_grant_id IS NULL)
          OR
          (entry_kind IN ('reservation', 'settlement', 'release')
            AND reservation_id IS NOT NULL AND delegation_id IS NULL
            AND child_run_id IS NULL AND child_grant_id IS NULL)
          OR
          (entry_kind IN ('parent_allocation', 'child_release')
            AND reservation_id IS NULL AND delegation_id IS NOT NULL
            AND child_run_id IS NOT NULL AND child_grant_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_agent_v3_budget_entries_grant
        ON agent_v3_budget_entries(grant_id, occurred_at, entry_id);
      CREATE UNIQUE INDEX idx_agent_v3_budget_reservation_open
        ON agent_v3_budget_entries(grant_id, reservation_id)
        WHERE entry_kind = 'reservation';
      CREATE UNIQUE INDEX idx_agent_v3_budget_reservation_close
        ON agent_v3_budget_entries(grant_id, reservation_id)
        WHERE entry_kind IN ('settlement', 'release');
      CREATE UNIQUE INDEX idx_agent_v3_budget_allocation
        ON agent_v3_budget_entries(grant_id, delegation_id)
        WHERE entry_kind = 'parent_allocation';
      CREATE UNIQUE INDEX idx_agent_v3_budget_child_release
        ON agent_v3_budget_entries(grant_id, delegation_id)
        WHERE entry_kind = 'child_release';

      CREATE TABLE agent_v3_delegations (
        delegation_id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        child_run_id TEXT NOT NULL UNIQUE,
        parent_grant_id TEXT NOT NULL,
        child_grant_id TEXT NOT NULL UNIQUE,
        objective_digest TEXT NOT NULL CHECK(
          length(objective_digest) = 71
          AND substr(objective_digest, 1, 7) = 'sha256:'
          AND substr(objective_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        objective_codec_id TEXT NOT NULL CHECK(length(objective_codec_id) > 0),
        objective_payload_json TEXT NOT NULL CHECK(json_valid(objective_payload_json)),
        required INTEGER NOT NULL CHECK(required IN (0, 1)),
        command_id TEXT NOT NULL,
        parent_run_version INTEGER NOT NULL CHECK(parent_run_version > 0),
        child_run_version INTEGER NOT NULL CHECK(child_run_version > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY(command_id, parent_run_id, parent_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(command_id, child_run_id, child_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(parent_grant_id)
          REFERENCES agent_v3_budget_grants(grant_id) ON DELETE RESTRICT,
        FOREIGN KEY(child_grant_id)
          REFERENCES agent_v3_budget_grants(grant_id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_agent_v3_delegations_parent
        ON agent_v3_delegations(parent_run_id, child_run_id);

      CREATE TABLE agent_v3_child_terminals (
        delegation_id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        child_run_id TEXT NOT NULL UNIQUE,
        child_run_version INTEGER NOT NULL CHECK(child_run_version > 0),
        child_status TEXT NOT NULL CHECK(child_status IN (
          'completed', 'failed', 'cancelled'
        )),
        command_id TEXT NOT NULL,
        parent_run_version INTEGER NOT NULL CHECK(parent_run_version > 0),
        observed_at TEXT NOT NULL,
        FOREIGN KEY(delegation_id)
          REFERENCES agent_v3_delegations(delegation_id) ON DELETE RESTRICT,
        FOREIGN KEY(command_id, parent_run_id, parent_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(child_run_id, child_run_version)
          REFERENCES agent_v3_command_runs(run_id, resulting_version)
          ON DELETE RESTRICT
      );
      CREATE INDEX idx_agent_v3_child_terminals_parent
        ON agent_v3_child_terminals(parent_run_id, child_run_id);

      CREATE TABLE agent_v3_events (
        event_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json)),
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(command_id, run_id, sequence),
        UNIQUE(command_id, run_id, run_version, sequence),
        UNIQUE(run_id, run_version, sequence)
      );
      CREATE INDEX idx_agent_v3_events_run
        ON agent_v3_events(run_id, run_version, sequence);

      CREATE TABLE agent_v3_outbox (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL DEFAULT 'agent_run'
          CHECK(aggregate_type = 'agent_run'),
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        event_json TEXT NOT NULL CHECK(json_valid(event_json)),
        created_at TEXT NOT NULL,
        published_at TEXT,
        published_claim_id TEXT,
        claim_id TEXT,
        claimed_at TEXT,
        claim_expires_at TEXT,
        publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempts >= 0),
        FOREIGN KEY(event_id) REFERENCES agent_v3_events(event_id) ON DELETE RESTRICT,
        FOREIGN KEY(command_id, aggregate_id, aggregate_version, sequence)
          REFERENCES agent_v3_events(command_id, run_id, run_version, sequence)
          ON DELETE RESTRICT,
        CHECK(
          (claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL)
          OR
          (claim_id IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL)
        ),
        CHECK(published_at IS NULL OR claim_id IS NULL)
      );
      CREATE INDEX idx_agent_v3_outbox_pending
        ON agent_v3_outbox(published_at, cursor);
      CREATE INDEX idx_agent_v3_outbox_aggregate
        ON agent_v3_outbox(aggregate_id, aggregate_version, cursor);
      CREATE INDEX idx_agent_v3_outbox_claimable
        ON agent_v3_outbox(published_at, claim_expires_at, cursor);
      CREATE INDEX idx_agent_v3_outbox_claim
        ON agent_v3_outbox(claim_id, published_at, cursor);

      CREATE TABLE agent_v3_checkpoints (
        run_id TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL CHECK(checkpoint_version > 0),
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        command_id TEXT NOT NULL,
        codec_id TEXT NOT NULL CHECK(length(codec_id) > 0),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, checkpoint_version),
        FOREIGN KEY(run_id) REFERENCES agent_v3_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(run_id, run_version),
        UNIQUE(command_id, run_id)
      );
      CREATE INDEX idx_agent_v3_checkpoints_command
        ON agent_v3_checkpoints(command_id, run_id);

      CREATE TABLE agent_v3_execution_intents (
        execution_intent_id TEXT PRIMARY KEY,
        source_outbox_message_id TEXT NOT NULL UNIQUE,
        intent_digest TEXT NOT NULL CHECK(
          length(intent_digest) = 71
          AND substr(intent_digest, 1, 7) = 'sha256:'
          AND substr(intent_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        intent_json TEXT NOT NULL CHECK(
          json_valid(intent_json)
          AND COALESCE(json_type(intent_json) = 'object', 0)
          AND COALESCE(
            json_extract(intent_json, '$.executionIntentId') = execution_intent_id,
            0
          )
          AND COALESCE(
            json_extract(intent_json, '$.sourceOutboxMessageId') = source_outbox_message_id,
            0
          )
          AND COALESCE(json_extract(intent_json, '$.runId') = run_id, 0)
          AND COALESCE(
            json_extract(intent_json, '$.admittedRunVersion') = admitted_run_version,
            0
          )
        ),
        run_id TEXT NOT NULL,
        admitted_run_version INTEGER NOT NULL CHECK(admitted_run_version = 1),
        admission_command_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'pending', 'dispatching', 'dispatched', 'settled'
        )),
        claim_id TEXT,
        claimed_at TEXT,
        claim_expires_at TEXT,
        claim_attempts INTEGER NOT NULL DEFAULT 0 CHECK(claim_attempts >= 0),
        dispatch_attempt_id TEXT,
        dispatch_started_at TEXT,
        external_dispatch_id TEXT,
        dispatch_receipt_digest TEXT CHECK(
          dispatch_receipt_digest IS NULL
          OR (
            length(dispatch_receipt_digest) = 71
            AND substr(dispatch_receipt_digest, 1, 7) = 'sha256:'
            AND substr(dispatch_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        dispatched_at TEXT,
        settlement_outcome TEXT CHECK(
          settlement_outcome IS NULL
          OR settlement_outcome IN ('completed', 'failed', 'cancelled')
        ),
        settlement_digest TEXT CHECK(
          settlement_digest IS NULL
          OR (
            length(settlement_digest) = 71
            AND substr(settlement_digest, 1, 7) = 'sha256:'
            AND substr(settlement_digest, 8) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        settled_at TEXT,
        FOREIGN KEY(admission_command_id, run_id, admitted_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(run_id, admitted_run_version),
        CHECK(
          (
            state = 'pending'
            AND dispatch_attempt_id IS NULL
            AND dispatch_started_at IS NULL
            AND external_dispatch_id IS NULL
            AND dispatch_receipt_digest IS NULL
            AND dispatched_at IS NULL
            AND settlement_outcome IS NULL
            AND settlement_digest IS NULL
            AND settled_at IS NULL
          )
          OR (
            state = 'dispatching'
            AND claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
            AND dispatch_attempt_id IS NOT NULL
            AND dispatch_started_at IS NOT NULL
            AND external_dispatch_id IS NULL
            AND dispatch_receipt_digest IS NULL
            AND dispatched_at IS NULL
            AND settlement_outcome IS NULL
            AND settlement_digest IS NULL
            AND settled_at IS NULL
          )
          OR (
            state = 'dispatched'
            AND claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
            AND dispatch_attempt_id IS NOT NULL
            AND dispatch_started_at IS NOT NULL
            AND external_dispatch_id IS NOT NULL
            AND dispatch_receipt_digest IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND settlement_outcome IS NULL
            AND settlement_digest IS NULL
            AND settled_at IS NULL
          )
          OR (
            state = 'settled'
            AND claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
            AND dispatch_attempt_id IS NOT NULL
            AND dispatch_started_at IS NOT NULL
            AND external_dispatch_id IS NOT NULL
            AND dispatch_receipt_digest IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND settlement_outcome IS NOT NULL
            AND settlement_digest IS NOT NULL
            AND settled_at IS NOT NULL
          )
        ),
        CHECK(
          state <> 'pending'
          OR (
            (claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL)
            OR
            (claim_id IS NOT NULL AND claimed_at IS NOT NULL
              AND claim_expires_at IS NOT NULL)
          )
        )
      );
      CREATE INDEX idx_agent_v3_execution_intents_pending
        ON agent_v3_execution_intents(state, claim_expires_at, created_at,
          execution_intent_id);
      CREATE INDEX idx_agent_v3_execution_intents_recovery
        ON agent_v3_execution_intents(state, created_at, execution_intent_id);
      CREATE INDEX idx_agent_v3_execution_intents_run
        ON agent_v3_execution_intents(run_id, admitted_run_version);

      CREATE TABLE agent_v3_effect_payloads (
        run_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        input_digest TEXT NOT NULL CHECK(length(input_digest) > 0),
        input_command_id TEXT NOT NULL,
        input_run_version INTEGER NOT NULL CHECK(input_run_version > 0),
        input_codec_id TEXT NOT NULL CHECK(length(input_codec_id) > 0),
        input_payload_json TEXT NOT NULL CHECK(json_valid(input_payload_json)),
        result_command_id TEXT,
        result_run_version INTEGER,
        result_codec_id TEXT,
        result_payload_json TEXT CHECK(
          result_payload_json IS NULL OR json_valid(result_payload_json)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, effect_id),
        FOREIGN KEY(run_id) REFERENCES agent_v3_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(input_command_id, run_id, input_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        FOREIGN KEY(result_command_id, run_id, result_run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        CHECK(
          (result_command_id IS NULL AND result_run_version IS NULL
            AND result_codec_id IS NULL AND result_payload_json IS NULL)
          OR
          (result_command_id IS NOT NULL AND result_run_version IS NOT NULL
            AND result_codec_id IS NOT NULL AND result_payload_json IS NOT NULL)
        )
      );
      CREATE INDEX idx_agent_v3_effect_payloads_run
        ON agent_v3_effect_payloads(run_id, effect_id);

      CREATE TABLE agent_v3_directive_payloads (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        payload_kind TEXT NOT NULL CHECK(payload_kind IN (
          'response_content', 'checkpoint_reason',
          'completion_output', 'failure_message'
        )),
        directive_digest TEXT NOT NULL CHECK(
          length(directive_digest) = 71
          AND substr(directive_digest, 1, 7) = 'sha256:'
        ),
        content_digest TEXT NOT NULL CHECK(
          length(content_digest) = 71
          AND substr(content_digest, 1, 7) = 'sha256:'
        ),
        codec_id TEXT NOT NULL CHECK(length(codec_id) > 0),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        recorded_at TEXT NOT NULL,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(command_id, run_id, artifact_id)
      );
      CREATE INDEX idx_agent_v3_directive_payloads_run
        ON agent_v3_directive_payloads(run_id, run_version, artifact_id);
    `);
}

function addAgentControlSchemaV5(database: DatabaseSync): void {
  database.exec(`
      CREATE TABLE agent_v3_turn_inputs (
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_digest TEXT NOT NULL CHECK(
          length(input_digest) = 71
          AND substr(input_digest, 1, 7) = 'sha256:'
          AND substr(input_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        command_id TEXT NOT NULL,
        run_version INTEGER NOT NULL CHECK(run_version > 0),
        codec_id TEXT NOT NULL CHECK(length(codec_id) > 0),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, turn_id),
        FOREIGN KEY(run_id) REFERENCES agent_v3_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(command_id, run_id, run_version)
          REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
          ON DELETE RESTRICT,
        UNIQUE(command_id, run_id),
        UNIQUE(run_id, run_version)
      );
      CREATE INDEX idx_agent_v3_turn_inputs_command
        ON agent_v3_turn_inputs(command_id, run_id, run_version);
    `);
}

function assertAgentControlSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version !== AGENT_CONTROL_DB_SCHEMA_VERSION) {
    throw new Error(
      `agent_control_schema_version_mismatch:${String(version)}:`
      + String(AGENT_CONTROL_DB_SCHEMA_VERSION)
    );
  }

  const actualSchema = listSchemaObjects(database);
  const expectedSchema = createCanonicalSchemaObjects();
  if (JSON.stringify(actualSchema) !== JSON.stringify(expectedSchema)) {
    throw new Error(
      `agent_control_schema_definition_mismatch:`
      + `${actualSchema.map(schemaObjectIdentity).join(',')}`
    );
  }

  const migrations = database.prepare(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  ).all() as unknown as Array<{
    version: number;
    name: string;
    applied_at: string;
  }>;
  if (
    migrations.length !== AGENT_CONTROL_DB_MIGRATIONS.length
    || migrations.some((row, index) => {
      const expected = AGENT_CONTROL_DB_MIGRATIONS[index];
      return expected === undefined
        || row.version !== expected.version
        || row.name !== expected.name
        || !isIsoTimestamp(row.applied_at);
    })
  ) {
    throw new Error('agent_control_schema_migration_history_mismatch');
  }

  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length > 0) {
    throw new Error('agent_control_schema_foreign_key_check_failed');
  }
  const integrity = database.prepare('PRAGMA quick_check').get() as {
    quick_check: string;
  };
  if (integrity.quick_check !== 'ok') {
    throw new Error(`agent_control_schema_integrity_check_failed:${integrity.quick_check}`);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return row.user_version;
}

function createCanonicalSchemaObjects(): readonly SchemaObject[] {
  const canonical = new DatabaseSync(':memory:');
  try {
    createAgentControlSchemaV4(canonical);
    addAgentControlSchemaV5(canonical);
    return listSchemaObjects(canonical);
  } finally {
    canonical.close();
  }
}

function listSchemaObjects(database: DatabaseSync): SchemaObject[] {
  const rows = database.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE type IN ('table', 'index', 'view', 'trigger')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`
  ).all() as unknown as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: normalizeSql(row.sql ?? '')
  }));
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/;$/u, '').trim().toLowerCase();
}

function schemaObjectIdentity(value: SchemaObject): string {
  return `${value.type}:${value.name}`;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
