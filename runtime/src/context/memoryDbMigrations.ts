import type { DatabaseSync } from "node:sqlite";

import { ensureRoutingTables } from "../model-router/route-stores.js";
import { ensureEvalTables } from "../model-router/eval-set-store.js";
import { backfillMessageEnvelopes } from "./messageEnvelopeBackfill.js";
import { addColumnIfMissing, hashRowId, type SqliteMigration } from "../storage/sqliteMigration.js";

export const MEMORY_DB_SCHEMA_VERSION = 41;

function ensureFts(
  db: DatabaseSync,
  ftsName: string,
  table: string,
  idCol: string,
  textCols: string[],
): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(ftsName) as { name: string } | undefined;
  if (!exists) {
    db.exec(`CREATE VIRTUAL TABLE ${ftsName} USING fts5(content, tokenize='unicode61');`);
  }

  const row = db
    .prepare(`SELECT value FROM agent_state WHERE key=?`)
    .get(`fts_sync:${ftsName}`) as { value: string } | undefined;
  if (row?.value === "1") return;

  const selectCols = textCols.map((c) => `COALESCE(${c}, '')`).join(" || ' ' || ");
  const rows = db
    .prepare(`SELECT ${idCol} AS id, ${selectCols} AS content FROM ${table}`)
    .all() as Array<{ id: string; content: string }>;

  const insert = db.prepare(`INSERT INTO ${ftsName}(rowid, content) VALUES (?, ?)`);
  for (const r of rows) {
    insert.run(hashRowId(r.id), r.content);
  }
  db
    .prepare(
      `INSERT INTO agent_state(key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`,
    )
    .run(`fts_sync:${ftsName}`, new Date().toISOString());
}

/** memory.db 递增迁移（v1–v14）；每步须幂等。归属 context/（owns memory.db），不在通用 storage/ 框架层。 */
export const MEMORY_DB_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "core_sessions_messages_memories",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          project_id TEXT,
          last_message_id TEXT,
          active_task_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

        CREATE TABLE IF NOT EXISTS conversation_summaries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_id TEXT,
          summary_type TEXT NOT NULL,
          content TEXT NOT NULL,
          start_message_id TEXT,
          end_message_id TEXT,
          token_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_session ON conversation_summaries(session_id, created_at);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          scope_id TEXT,
          memory_type TEXT NOT NULL,
          key TEXT,
          value TEXT NOT NULL,
          summary TEXT,
          importance REAL NOT NULL DEFAULT 0.5,
          confidence REAL NOT NULL DEFAULT 1.0,
          source TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id, is_active);

        CREATE TABLE IF NOT EXISTS agent_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: "tasks_and_steps",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          project_id TEXT,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_steps (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          required_permissions_json TEXT NOT NULL,
          needs_confirmation INTEGER NOT NULL DEFAULT 0,
          acceptance TEXT,
          tool TEXT,
          tool_input_json TEXT,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(task_id, step_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, position);

        CREATE TABLE IF NOT EXISTS task_step_dependencies (
          task_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          depends_on_step_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(task_id, step_id, depends_on_step_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE TABLE IF NOT EXISTS task_attempts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step_id TEXT,
          run_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          result TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id, started_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: "projects_and_runs",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          parent_run_id TEXT,
          trigger_id TEXT,
          goal TEXT,
          error TEXT,
          result_json TEXT,
          correlation_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: "internal_task_plans",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_plans (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          kind TEXT NOT NULL,
          goal TEXT NOT NULL,
          mode TEXT NOT NULL,
          internal_json TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_plan_versions (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          internal_json TEXT NOT NULL,
          plan_hash TEXT NOT NULL,
          change_reason TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(plan_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_plan_versions_plan ON task_plan_versions(plan_id, version);

        CREATE TABLE IF NOT EXISTS task_plan_previews (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          format TEXT NOT NULL,
          content TEXT NOT NULL,
          source_plan_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_previews_plan ON task_plan_previews(plan_id, version, format);

        CREATE TABLE IF NOT EXISTS task_plan_approvals (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          approved_by TEXT NOT NULL,
          approval_status TEXT NOT NULL,
          comment TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_plan_runs (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          stop_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_runs_plan ON task_plan_runs(plan_id, created_at DESC);
      `);
    },
  },
  {
    version: 5,
    name: "user_visible_plans",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_visible_plans (
          id TEXT PRIMARY KEY,
          source_run_id TEXT NOT NULL,
          session_id TEXT,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          todos_json TEXT NOT NULL,
          risks_json TEXT NOT NULL,
          requires_user_confirmation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_visible_plans_run ON user_visible_plans(source_run_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_visible_plans_session ON user_visible_plans(session_id, created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: "column_extensions",
    up(db) {
      addColumnIfMissing(db, "messages", "is_summarized", "is_summarized INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "messages", "summary_id", "summary_id TEXT");
      addColumnIfMissing(db, "conversation_summaries", "structured_json", "structured_json TEXT");
      addColumnIfMissing(db, "memories", "source_id", "source_id TEXT");
      addColumnIfMissing(db, "memories", "supersedes_id", "supersedes_id TEXT");
      addColumnIfMissing(db, "tasks", "inputs_json", "inputs_json TEXT");
      addColumnIfMissing(db, "tasks", "outputs_json", "outputs_json TEXT");
      addColumnIfMissing(db, "tasks", "acceptance_criteria_json", "acceptance_criteria_json TEXT");
      addColumnIfMissing(db, "task_steps", "objective", "objective TEXT");
      addColumnIfMissing(db, "task_steps", "required_context_json", "required_context_json TEXT");
      addColumnIfMissing(db, "task_steps", "available_tools_json", "available_tools_json TEXT");
      addColumnIfMissing(db, "task_steps", "expected_artifacts_json", "expected_artifacts_json TEXT");
      addColumnIfMissing(db, "task_steps", "priority", "priority INTEGER NOT NULL DEFAULT 100");
    },
  },
  {
    version: 7,
    name: "fts_and_routing_tables",
    up(db) {
      ensureFts(db, "messages_fts", "messages", "id", ["content"]);
      ensureFts(db, "summaries_fts", "conversation_summaries", "id", ["content"]);
      ensureFts(db, "memories_fts", "memories", "id", ["value", "summary"]);
      ensureRoutingTables(db);
    },
  },
  {
    version: 8,
    name: "model_eval_tables",
    up(db) {
      ensureEvalTables(db);
    },
  },
  {
    version: 9,
    name: "run_states",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_states (
          run_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          goal TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          status TEXT NOT NULL,
          state_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(id)
        );
        CREATE INDEX IF NOT EXISTS idx_run_states_status ON run_states(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_run_states_session ON run_states(session_id, updated_at DESC);
      `);
    },
  },
  {
    version: 10,
    name: "project_index",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_files (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          extension TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          modified_at TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          language TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          summary TEXT,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (project_id, workspace_root, path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_files_root ON project_files(workspace_root, indexed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_project_files_hash ON project_files(project_id, workspace_root, content_hash);

        CREATE TABLE IF NOT EXISTS project_symbols (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          symbol TEXT NOT NULL,
          kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (project_id, workspace_root, file_path, symbol)
        );
        CREATE INDEX IF NOT EXISTS idx_project_symbols_name ON project_symbols(project_id, workspace_root, symbol);
      `);
    },
  },
  {
    version: 11,
    name: "project_dependencies",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_imports (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          from_path TEXT NOT NULL,
          import_spec TEXT NOT NULL,
          resolved_path TEXT,
          kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (project_id, workspace_root, from_path, import_spec, line)
        );
        CREATE INDEX IF NOT EXISTS idx_project_imports_from
          ON project_imports(project_id, workspace_root, from_path);
        CREATE INDEX IF NOT EXISTS idx_project_imports_to
          ON project_imports(project_id, workspace_root, resolved_path);

        CREATE TABLE IF NOT EXISTS project_exports (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          export_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (project_id, workspace_root, file_path, export_name)
        );
        CREATE INDEX IF NOT EXISTS idx_project_exports_name
          ON project_exports(project_id, workspace_root, export_name);
      `);
    },
  },
  {
    version: 12,
    name: "task_plan_run_steps",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_plan_run_steps (
          id TEXT PRIMARY KEY,
          plan_run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          status TEXT NOT NULL,
          tool_name TEXT,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          output_preview TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_run_steps_run
          ON task_plan_run_steps(plan_run_id, created_at);
      `);
    },
  },
  {
    version: 13,
    name: "sessions_workspace_key",
    up(db) {
      addColumnIfMissing(db, "sessions", "workspace_key", "workspace_key TEXT");
    },
  },
  {
    version: 14,
    name: "durable_permission_pauses",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS permission_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          responded_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_permission_requests_run_status
          ON permission_requests(run_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_permission_requests_session_status
          ON permission_requests(session_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS paused_run_snapshots (
          run_id TEXT PRIMARY KEY,
          session_id TEXT,
          status TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_paused_run_snapshots_session_status
          ON paused_run_snapshots(session_id, status, updated_at DESC);
      `);
    },
  },
  {
    version: 15,
    name: "session_permission_grants",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_permission_grants (
          session_id TEXT PRIMARY KEY,
          grants_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 16,
    name: "plan_handoffs",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plan_handoffs (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          responded_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plan_handoffs_session_status
          ON plan_handoffs(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plan_handoffs_run_status
          ON plan_handoffs(run_id, status, updated_at DESC);
      `);
    },
  },
  {
    version: 17,
    name: "session_task_contexts",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_task_contexts (
          session_id TEXT PRIMARY KEY,
          task_id TEXT,
          goal TEXT,
          current_phase TEXT NOT NULL,
          intent TEXT NOT NULL,
          workflow_type TEXT NOT NULL,
          last_run_id TEXT,
          last_failure TEXT,
          related_files_json TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_task_contexts_active
          ON session_task_contexts(is_active, updated_at DESC);
      `);
    },
  },
  {
    version: 18,
    name: "session_task_contexts_side_effect",
    up(db) {
      db.exec(`
        ALTER TABLE session_task_contexts ADD COLUMN last_stop_reason TEXT;
        ALTER TABLE session_task_contexts ADD COLUMN last_completed_at TEXT;
        ALTER TABLE session_task_contexts ADD COLUMN side_effect_summary_json TEXT;
      `);
    },
  },
  {
    version: 19,
    name: "messages_model_meta",
    up(db) {
      addColumnIfMissing(db, "messages", "client_name", "client_name TEXT");
      addColumnIfMissing(db, "messages", "model_name", "model_name TEXT");
    },
  },
  {
    version: 20,
    name: "messages_envelope",
    up(db) {
      addColumnIfMissing(db, "messages", "message_kind", "message_kind TEXT");
      addColumnIfMissing(db, "messages", "ui_visible", "ui_visible INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(db, "messages", "trusted", "trusted INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "messages", "source", "source TEXT");
      addColumnIfMissing(db, "messages", "run_id", "run_id TEXT");
    },
  },
  {
    version: 21,
    name: "messages_envelope_backfill",
    up(db) {
      backfillMessageEnvelopes(db);
    },
  },
  {
    version: 22,
    name: "session_task_contexts_entry_reconciled",
    up(db) {
      addColumnIfMissing(db, "session_task_contexts", "entry_intent", "entry_intent TEXT");
      addColumnIfMissing(db, "session_task_contexts", "entry_workflow_type", "entry_workflow_type TEXT");
      addColumnIfMissing(db, "session_task_contexts", "reconciled_intent", "reconciled_intent TEXT");
      addColumnIfMissing(
        db,
        "session_task_contexts",
        "reconciled_workflow_type",
        "reconciled_workflow_type TEXT",
      );
      addColumnIfMissing(
        db,
        "session_task_contexts",
        "last_completion_status",
        "last_completion_status TEXT",
      );
    },
  },
  {
    version: 23,
    name: "messages_tool_outcome_meta",
    up(db) {
      addColumnIfMissing(db, "messages", "ledger_backed", "ledger_backed INTEGER");
      addColumnIfMissing(db, "messages", "outcome_class", "outcome_class TEXT");
      addColumnIfMissing(db, "messages", "outcome_kind", "outcome_kind TEXT");
    },
  },
  {
    version: 24,
    name: "workspace_grants_and_audit",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_grants (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          project_id TEXT,
          task_id TEXT,
          root_path TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          scope TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT,
          revoked_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_grants_session
          ON workspace_grants(session_id, revoked_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_grants_project
          ON workspace_grants(project_id, revoked_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_grants_root
          ON workspace_grants(root_path, revoked_at, updated_at DESC);

        CREATE TABLE IF NOT EXISTS workspace_access_audit (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          session_id TEXT,
          task_id TEXT,
          tool_call_id TEXT,
          tool_name TEXT NOT NULL,
          operation TEXT NOT NULL,
          normalized_path TEXT NOT NULL,
          matched_root TEXT,
          workspace_scope_id TEXT,
          grant_id TEXT,
          permission_source TEXT,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL,
          cross_workspace INTEGER NOT NULL,
          path_risk TEXT NOT NULL,
          path_risk_tier TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_access_audit_run
          ON workspace_access_audit(run_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_access_audit_session
          ON workspace_access_audit(session_id, created_at DESC);
      `);
    },
  },
  {
    version: 25,
    name: "messages_fail_closed_trust_basis",
    up(db) {
      addColumnIfMissing(db, "messages", "trust_basis", "trust_basis TEXT");
      db.exec(`
        UPDATE messages
        SET trust_basis = 'user_authored', trusted = 1, ui_visible = 1, source = 'user'
        WHERE role = 'user' AND message_kind = 'user_input';

        UPDATE messages
        SET trust_basis = NULL, trusted = 0, ui_visible = 0
        WHERE role <> 'user';
      `);
    },
  },
  {
    version: 26,
    name: "model_agent_protocol_qualification",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_agent_protocol_qualification (
          model_id TEXT PRIMARY KEY,
          profile_fingerprint TEXT NOT NULL,
          protocol_version INTEGER NOT NULL,
          status TEXT NOT NULL,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_checked_at TEXT,
          qualified_at TEXT,
          quarantined_at TEXT,
          quarantine_until TEXT,
          reason TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_agent_protocol_status
          ON model_agent_protocol_qualification(status, quarantine_until);
      `);
    },
  },
  {
    version: 27,
    name: "messages_native_tool_protocol",
    up(db) {
      addColumnIfMissing(db, "messages", "tool_name", "tool_name TEXT");
      addColumnIfMissing(db, "messages", "tool_call_id", "tool_call_id TEXT");
      addColumnIfMissing(db, "messages", "tool_calls_json", "tool_calls_json TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_tool_call_id
          ON messages(tool_call_id);
      `);
    },
  },
  {
    version: 28,
    name: "workspace_grant_integrity_quarantine",
    up(db) {
      db.exec(`
        UPDATE workspace_grants
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            revoked_reason = 'migration_invalid_workspace_grant',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE
          trim(id) = ''
          OR trim(root_path) = ''
          OR scope NOT IN ('session', 'project', 'workspace')
          OR source NOT IN ('user_confirmed', 'config')
          OR (scope = 'session' AND (session_id IS NULL OR trim(session_id) = '' OR project_id IS NOT NULL))
          OR (scope = 'project' AND (project_id IS NULL OR trim(project_id) = '' OR session_id IS NOT NULL))
          OR (scope = 'workspace' AND (session_id IS NOT NULL OR project_id IS NOT NULL))
          OR (task_id IS NOT NULL AND trim(task_id) = '')
          OR julianday(created_at) IS NULL
          OR julianday(updated_at) IS NULL
          OR (expires_at IS NOT NULL AND julianday(expires_at) IS NULL)
          OR (revoked_at IS NOT NULL AND julianday(revoked_at) IS NULL)
          OR (revoked_at IS NULL AND revoked_reason IS NOT NULL)
          OR (revoked_at IS NOT NULL AND (revoked_reason IS NULL OR trim(revoked_reason) = ''))
          OR CASE
            WHEN json_valid(permissions_json) THEN
              json_type(permissions_json) != 'array'
              OR json_array_length(permissions_json) = 0
              OR EXISTS (
                SELECT 1
                FROM json_each(permissions_json)
                WHERE type != 'text' OR value NOT IN ('read', 'write', 'shell')
              )
              OR (
                SELECT COUNT(*)
                FROM json_each(permissions_json)
              ) != (
                SELECT COUNT(DISTINCT value)
                FROM json_each(permissions_json)
              )
            ELSE 1
          END;
      `);
    },
  },
  {
    version: 29,
    name: "assistant_agent_handoff_state",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_agent_proposals (
          id TEXT PRIMARY KEY,
          source_turn_id TEXT NOT NULL UNIQUE,
          companion_session_id TEXT,
          agent_session_id TEXT,
          status TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          grant_id TEXT,
          run_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          responded_at TEXT
        );

        CREATE TABLE IF NOT EXISTS assistant_agent_grants (
          id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consumed_at TEXT,
          FOREIGN KEY(proposal_id) REFERENCES assistant_agent_proposals(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS assistant_session_links (
          companion_session_id TEXT PRIMARY KEY,
          agent_session_id TEXT NOT NULL UNIQUE,
          workspace_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_agent_proposals_session_status
          ON assistant_agent_proposals(companion_session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assistant_agent_proposals_run
          ON assistant_agent_proposals(run_id);
      `);
    },
  },
  {
    version: 30,
    name: "assistant_agent_companion_storage_binding",
    up(db) {
      addColumnIfMissing(
        db,
        "assistant_agent_proposals",
        "companion_storage_root",
        "companion_storage_root TEXT",
      );
    },
  },
  {
    version: 31,
    name: "assistant_session_read_grants",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_session_read_grants (
          id TEXT PRIMARY KEY,
          companion_session_id TEXT NOT NULL UNIQUE,
          workspace_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_session_read_grants_status
          ON assistant_session_read_grants(status, updated_at DESC);
      `);
    },
  },
  {
    version: 32,
    name: "plan_agent_step_bindings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plan_agent_step_bindings (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          plan_version INTEGER NOT NULL,
          plan_run_id TEXT NOT NULL,
          parent_run_id TEXT NOT NULL,
          parent_task_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          step_row_id TEXT NOT NULL,
          child_run_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN (
            'waiting_child', 'continuing', 'completed', 'failed', 'cancelled'
          )),
          payload_json TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY(parent_run_id) REFERENCES runs(id) ON DELETE CASCADE,
          FOREIGN KEY(child_run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_plan_agent_step_bindings_parent
          ON plan_agent_step_bindings(parent_run_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_plan_agent_step_bindings_plan_run
          ON plan_agent_step_bindings(plan_run_id, status, updated_at);
      `);
    },
  },
  {
    version: 33,
    name: "assistant_companion_session_deletion_intents",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_companion_session_deletions (
          id TEXT PRIMARY KEY,
          companion_session_id TEXT NOT NULL UNIQUE,
          storage_root TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_companion_session_deletions_created
          ON assistant_companion_session_deletions(created_at);
      `);
    },
  },
  {
    version: 34,
    name: "run_aggregates_checkpoints_tool_ledger_and_domain_outbox",
    up(db) {
      db.exec(`
        CREATE TABLE run_aggregates (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'running', 'blocked', 'waiting_confirmation',
            'waiting_plan_handoff', 'paused', 'recovery_required',
            'completed', 'failed', 'cancelled'
          )),
          aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
          session_id TEXT,
          task_id TEXT,
          parent_run_id TEXT,
          trigger_id TEXT,
          goal TEXT,
          round INTEGER NOT NULL DEFAULT 0 CHECK(round >= 0),
          checkpoint_stage TEXT NOT NULL,
          recovery_status TEXT NOT NULL CHECK(recovery_status IN (
            'none', 'recoverable', 'decision_required'
          )),
          wait_reason_json TEXT,
          state_json TEXT NOT NULL,
          error TEXT,
          result_json TEXT,
          correlation_id TEXT,
          causation_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(parent_run_id) REFERENCES run_aggregates(id)
        );
        CREATE INDEX idx_run_aggregates_session
          ON run_aggregates(session_id, created_at DESC);
        CREATE INDEX idx_run_aggregates_status
          ON run_aggregates(status, updated_at DESC);

        CREATE TABLE run_checkpoints (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
          stage TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, aggregate_version),
          FOREIGN KEY(run_id) REFERENCES run_aggregates(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_run_checkpoints_run
          ON run_checkpoints(run_id, aggregate_version);

        CREATE TABLE tool_ledger (
          idempotency_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'intended', 'started', 'succeeded', 'failed',
            'cancelled', 'recovery_required'
          )),
          aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
          input_hash TEXT NOT NULL,
          output_json TEXT,
          verification_json TEXT,
          effects_json TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_aggregates(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_tool_ledger_run
          ON tool_ledger(run_id, aggregate_version);

        CREATE TABLE domain_event_outbox (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          schema_version TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
          correlation_id TEXT,
          causation_id TEXT,
          event_type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX idx_domain_event_outbox_aggregate
          ON domain_event_outbox(aggregate_type, aggregate_id, aggregate_version);

        CREATE TABLE event_consumers (
          consumer_id TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
          updated_at TEXT NOT NULL
        );

        INSERT INTO run_aggregates (
          id, kind, status, aggregate_version, session_id, task_id,
          parent_run_id, trigger_id, goal, checkpoint_stage, recovery_status,
          state_json, error, result_json, correlation_id, created_at, updated_at
        )
        SELECT
          id,
          kind,
          CASE
            WHEN status IN ('completed', 'failed', 'cancelled') THEN status
            ELSE 'recovery_required'
          END,
          1,
          session_id,
          task_id,
          parent_run_id,
          trigger_id,
          goal,
          'migrated',
          CASE
            WHEN status IN ('completed', 'failed', 'cancelled') THEN 'none'
            ELSE 'decision_required'
          END,
          json_object(
            'round', 0,
            'plan', NULL,
            'childRunIds', json_array(),
            'inFlightEffects', json_array(),
            'verificationEvidence', json_array(),
            'legacyStatus', status
          ),
          error,
          result_json,
          CASE
            WHEN correlation_json IS NOT NULL AND json_valid(correlation_json)
            THEN json_extract(correlation_json, '$.correlationId')
            ELSE NULL
          END,
          created_at,
          updated_at
        FROM runs;

        INSERT INTO run_checkpoints (
          id, run_id, aggregate_version, stage, snapshot_json, created_at
        )
        SELECT
          lower(hex(randomblob(16))),
          id,
          1,
          'migrated',
          json_object(
            'runId', id,
            'legacyStatus', status,
            'migrationDisposition',
            CASE
              WHEN status IN ('completed', 'failed', 'cancelled')
                THEN 'historical_projection'
              ELSE 'recovery_required'
            END
          ),
          updated_at
        FROM runs;
      `);
    },
  },
  {
    version: 35,
    name: "run_aggregate_foreign_key_cutover",
    up(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_run_states_status;
        DROP INDEX IF EXISTS idx_run_states_session;
        ALTER TABLE run_states RENAME TO run_states_legacy_v34;
        CREATE TABLE run_states (
          run_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          goal TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          status TEXT NOT NULL,
          state_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES run_aggregates(id) ON DELETE CASCADE
        );
        INSERT INTO run_states (
          run_id, mode, goal, session_id, task_id, status, state_json, created_at, updated_at
        )
        SELECT
          state.run_id, state.mode, state.goal, state.session_id, state.task_id,
          state.status, state.state_json, state.created_at, state.updated_at
        FROM run_states_legacy_v34 state
        INNER JOIN run_aggregates aggregate ON aggregate.id = state.run_id;
        DROP TABLE run_states_legacy_v34;
        CREATE INDEX idx_run_states_status ON run_states(status, updated_at DESC);
        CREATE INDEX idx_run_states_session ON run_states(session_id, updated_at DESC);

        DROP INDEX IF EXISTS idx_plan_agent_step_bindings_parent;
        DROP INDEX IF EXISTS idx_plan_agent_step_bindings_plan_run;
        ALTER TABLE plan_agent_step_bindings RENAME TO plan_agent_step_bindings_legacy_v34;
        CREATE TABLE plan_agent_step_bindings (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          plan_version INTEGER NOT NULL,
          plan_run_id TEXT NOT NULL,
          parent_run_id TEXT NOT NULL,
          parent_task_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          step_row_id TEXT NOT NULL,
          child_run_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN (
            'waiting_child', 'continuing', 'completed', 'failed', 'cancelled'
          )),
          payload_json TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY(parent_run_id) REFERENCES run_aggregates(id) ON DELETE CASCADE,
          FOREIGN KEY(child_run_id) REFERENCES run_aggregates(id) ON DELETE CASCADE
        );
        INSERT INTO plan_agent_step_bindings (
          id, plan_id, plan_version, plan_run_id, parent_run_id, parent_task_id,
          step_id, step_row_id, child_run_id, status, payload_json, error,
          created_at, updated_at, finished_at
        )
        SELECT
          binding.id, binding.plan_id, binding.plan_version, binding.plan_run_id,
          binding.parent_run_id, binding.parent_task_id, binding.step_id,
          binding.step_row_id, binding.child_run_id, binding.status,
          binding.payload_json, binding.error, binding.created_at,
          binding.updated_at, binding.finished_at
        FROM plan_agent_step_bindings_legacy_v34 binding
        INNER JOIN run_aggregates parent ON parent.id = binding.parent_run_id
        INNER JOIN run_aggregates child ON child.id = binding.child_run_id;
        DROP TABLE plan_agent_step_bindings_legacy_v34;
        CREATE INDEX idx_plan_agent_step_bindings_parent
          ON plan_agent_step_bindings(parent_run_id, status, updated_at);
        CREATE INDEX idx_plan_agent_step_bindings_plan_run
          ON plan_agent_step_bindings(plan_run_id, status, updated_at);
      `);
    },
  },
  {
    version: 36,
    name: "structured_content_envelopes",
    up(db) {
      addColumnIfMissing(
        db,
        "messages",
        "content_envelope_json",
        "content_envelope_json TEXT",
      );
      db.exec(`
        UPDATE messages
        SET content_envelope_json = json_object(
          'origin', CASE
            WHEN source IN ('user', 'model', 'guard', 'tool', 'workflow', 'system') THEN source
            WHEN role = 'user' THEN 'user'
            WHEN role = 'tool' THEN 'tool'
            WHEN role = 'assistant' THEN 'model'
            ELSE 'workflow'
          END,
          'provenance', json_object('runId', run_id),
          'integrityEvidence', json_object(
            'kind', COALESCE(trust_basis, 'unverified'),
            'verified', CASE WHEN trusted = 1 THEN json('true') ELSE json('false') END
          ),
          'instructionAuthority', CASE
            WHEN role = 'user' THEN 'user'
            WHEN source IN ('guard', 'system') THEN 'system'
            ELSE 'data'
          END,
          'dataSensitivity', 'workspace',
          'externalContent', CASE
            WHEN source IN ('model', 'tool') THEN json('true')
            ELSE json('false')
          END,
          'egressAllowed', CASE
            WHEN role = 'user' THEN json_array('model')
            ELSE json_array()
          END
        )
        WHERE content_envelope_json IS NULL;
      `);
    },
  },
  {
    version: 37,
    name: "versioned_summary_generation_evidence",
    up(db) {
      addColumnIfMissing(
        db,
        "conversation_summaries",
        "schema_version",
        "schema_version INTEGER NOT NULL DEFAULT 1",
      );
      addColumnIfMissing(
        db,
        "conversation_summaries",
        "generation_state",
        "generation_state TEXT NOT NULL DEFAULT 'degraded'",
      );
      addColumnIfMissing(
        db,
        "conversation_summaries",
        "degraded_reason",
        "degraded_reason TEXT",
      );
      db.exec(`
        UPDATE conversation_summaries
        SET schema_version=1,
            generation_state='degraded',
            degraded_reason=COALESCE(degraded_reason, 'historical_summary_provenance_unknown');
      `);
    },
  },
  {
    version: 38,
    name: "governed_memory_lifecycle",
    up(db) {
      addColumnIfMissing(
        db,
        "memories",
        "lifecycle_state",
        "lifecycle_state TEXT NOT NULL DEFAULT 'candidate'",
      );
      addColumnIfMissing(db, "memories", "provenance_json", "provenance_json TEXT");
      addColumnIfMissing(
        db,
        "memories",
        "sensitivity",
        "sensitivity TEXT NOT NULL DEFAULT 'workspace'",
      );
      addColumnIfMissing(db, "memories", "retention_until", "retention_until TEXT");
      db.exec(`
        UPDATE memories
        SET lifecycle_state=CASE WHEN is_active=1 THEN 'active' ELSE 'rejected' END,
            provenance_json=json_object(
              'origin', CASE
                WHEN source='tool_ledger' THEN 'tool_ledger'
                WHEN source IN ('summary', 'llm_extractor') THEN 'model_summary'
                WHEN source='extractor' THEN 'user'
                ELSE 'system'
              END,
              'sourceId', source_id,
              'evidence', 'historical_migration'
            ),
            sensitivity='workspace',
            retention_until=expires_at
        WHERE provenance_json IS NULL;
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_lifecycle
          ON memories(lifecycle_state, scope, scope_id, updated_at DESC);
      `);
    },
  },
  {
    version: 39,
    name: "persistent_repo_map_references_and_diagnostics",
    up(db) {
      db.exec(`
        CREATE TABLE project_references (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          symbol TEXT NOT NULL,
          kind TEXT NOT NULL,
          line INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY(project_id, workspace_root, file_path, symbol, kind, line)
        );
        CREATE INDEX idx_project_references_symbol
          ON project_references(project_id, workspace_root, symbol);
        CREATE INDEX idx_project_references_file
          ON project_references(project_id, workspace_root, file_path);

        CREATE TABLE project_diagnostics (
          project_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          message TEXT NOT NULL,
          line INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY(project_id, workspace_root, file_path, message, line)
        );
        CREATE INDEX idx_project_diagnostics_file
          ON project_diagnostics(project_id, workspace_root, file_path);
      `);
    },
  },
  {
    version: 40,
    name: "durable_hook_deliveries",
    up(db) {
      db.exec(`
        CREATE TABLE hook_deliveries (
          delivery_id TEXT PRIMARY KEY,
          hook_id TEXT NOT NULL,
          hook_version TEXT NOT NULL,
          event TEXT NOT NULL,
          event_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('delivering', 'delivered', 'failed')),
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_hook_deliveries_event
          ON hook_deliveries(event, event_id, updated_at);
      `);
    },
  },
  {
    version: 41,
    name: "content_addressed_resource_registry",
    up(db) {
      db.exec(`
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_resources_owner
          ON resources(owner_type, owner_id, created_at DESC);
        CREATE INDEX idx_resources_hash
          ON resources(sha256);
        CREATE INDEX idx_resources_expiry
          ON resources(expires_at);
      `);
    },
  },
];
