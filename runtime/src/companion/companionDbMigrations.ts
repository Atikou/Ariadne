import type { SqliteMigration } from "../storage/sqliteMigration.js";
import { DEFAULT_PERSONA } from "./PersonaRuntime.js";

export const COMPANION_DB_SCHEMA_VERSION = 7;

export const COMPANION_DB_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "companion_core_sessions_messages_summaries",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_sessions (
          id TEXT PRIMARY KEY,
          persona_id TEXT NOT NULL,
          title TEXT NOT NULL,
          storage_root TEXT NOT NULL,
          incognito INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_summary_message_id TEXT
        );

        CREATE TABLE IF NOT EXISTS companion_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          trusted INTEGER NOT NULL DEFAULT 1,
          memory_eligible INTEGER NOT NULL DEFAULT 1,
          model_name TEXT,
          client_name TEXT,
          storage_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS companion_summaries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_message_start_id TEXT NOT NULL,
          source_message_end_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          topics_json TEXT NOT NULL DEFAULT '[]',
          trust_level TEXT NOT NULL DEFAULT 'generated',
          model_name TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_companion_sessions_updated
          ON companion_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_companion_messages_session_created
          ON companion_messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_companion_summaries_session_created
          ON companion_summaries(session_id, created_at);
      `);
    },
  },
  {
    version: 2,
    name: "companion_personas_memories_vectors",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_personas (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          description TEXT,
          readonly INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS companion_persona_versions (
          id TEXT PRIMARY KEY,
          persona_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(persona_id) REFERENCES companion_personas(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS companion_memory_candidates (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          source_message_id TEXT,
          kind TEXT NOT NULL,
          key TEXT,
          value TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'candidate',
          output_mode TEXT NOT NULL DEFAULT 'bounded',
          reason TEXT,
          sensitivity TEXT NOT NULL DEFAULT 'low',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS companion_memories (
          id TEXT PRIMARY KEY,
          candidate_id TEXT,
          session_id TEXT,
          kind TEXT NOT NULL,
          key TEXT,
          value TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'confirmed',
          output_mode TEXT NOT NULL DEFAULT 'bounded',
          importance REAL NOT NULL DEFAULT 0.6,
          confidence REAL NOT NULL DEFAULT 0.8,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(candidate_id) REFERENCES companion_memory_candidates(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS companion_vector_items (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          output_mode TEXT NOT NULL DEFAULT 'bounded',
          content TEXT NOT NULL,
          summary TEXT,
          indexed_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_persona_versions_unique
          ON companion_persona_versions(persona_id, version);
        CREATE INDEX IF NOT EXISTS idx_companion_personas_active
          ON companion_personas(active, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_companion_memory_candidates_status
          ON companion_memory_candidates(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_companion_memories_status_mode
          ON companion_memories(status, output_mode, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_vector_items_source
          ON companion_vector_items(source_type, source_id);
      `);
    },
  },
  {
    version: 3,
    name: "single_immutable_default_persona",
    up(db) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const at = new Date().toISOString();
        db.prepare(
          `INSERT INTO companion_personas
            (id, name, system_prompt, description, readonly, active, version, created_at, updated_at)
           VALUES ('default', ?, ?, '内置默认人格', 1, 1, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,
             system_prompt=excluded.system_prompt,
             description=excluded.description,
             readonly=1,
             active=1`,
        ).run(DEFAULT_PERSONA.name, DEFAULT_PERSONA.systemPrompt, at, at);
        db.prepare(
          `INSERT OR IGNORE INTO companion_persona_versions
            (id, persona_id, version, name, system_prompt, description, created_at)
           VALUES ('default:1', 'default', 1, ?, ?, '内置默认人格', ?)`,
        ).run(DEFAULT_PERSONA.name, DEFAULT_PERSONA.systemPrompt, at);

        const redundant = db
          .prepare(
            `SELECT id FROM companion_personas
             WHERE id != 'default'
               AND system_prompt = ?
               AND lower(trim(name)) IN ('companion', 'companion 副本')`,
          )
          .all(DEFAULT_PERSONA.systemPrompt) as Array<{ id: string }>;
        for (const persona of redundant) {
          db.prepare(`UPDATE companion_sessions SET persona_id='default' WHERE persona_id=?`).run(persona.id);
          db.prepare(`DELETE FROM companion_personas WHERE id=?`).run(persona.id);
        }

        const activePersonas = db
          .prepare(
            `SELECT id, name FROM companion_personas
             WHERE active=1
             ORDER BY readonly DESC, created_at ASC, id ASC`,
          )
          .all() as Array<{ id: string; name: string }>;
        const usedNames = new Set<string>();
        for (const persona of activePersonas) {
          const baseName = persona.name.trim() || "自定义人格";
          let uniqueName = baseName;
          let suffix = 2;
          while (usedNames.has(uniqueName.toLocaleLowerCase())) {
            uniqueName = `${baseName} (${suffix})`;
            suffix += 1;
          }
          usedNames.add(uniqueName.toLocaleLowerCase());
          if (uniqueName !== persona.name) {
            db.prepare(`UPDATE companion_personas SET name=? WHERE id=?`).run(uniqueName, persona.id);
          }
        }

        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_personas_active_name
            ON companion_personas(lower(trim(name))) WHERE active=1;

          CREATE TRIGGER IF NOT EXISTS trg_companion_default_persona_no_delete
          BEFORE DELETE ON companion_personas
          WHEN OLD.id='default'
          BEGIN
            SELECT RAISE(ABORT, 'default_persona_cannot_be_deleted');
          END;

          CREATE TRIGGER IF NOT EXISTS trg_companion_default_persona_no_update
          BEFORE UPDATE ON companion_personas
          WHEN OLD.id='default'
          BEGIN
            SELECT RAISE(ABORT, 'default_persona_is_immutable');
          END;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  },
  {
    version: 4,
    name: "unique_atomic_memory_candidate_confirmation",
    up(db) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          UPDATE companion_memories
          SET candidate_id=NULL
          WHERE candidate_id IS NOT NULL
            AND rowid NOT IN (
              SELECT MIN(rowid)
              FROM companion_memories
              WHERE candidate_id IS NOT NULL
              GROUP BY candidate_id
            );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_memories_candidate_unique
            ON companion_memories(candidate_id)
            WHERE candidate_id IS NOT NULL;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  },
  {
    version: 5,
    name: "persistent_unrestricted_memory_aliases",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_memory_migration_aliases (
          legacy_id TEXT NOT NULL,
          record_type TEXT NOT NULL CHECK(record_type IN ('memory', 'candidate')),
          target_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(legacy_id, record_type)
        );

        CREATE INDEX IF NOT EXISTS idx_companion_memory_alias_target
          ON companion_memory_migration_aliases(record_type, target_id);
      `);
    },
  },
  {
    version: 6,
    name: "agent_result_presentations",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_agent_result_presentations (
          projection_key TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          run_id TEXT,
          outcome_status TEXT NOT NULL
            CHECK(outcome_status IN ('completed', 'waiting_permission', 'waiting_plan_handoff', 'failed')),
          session_id TEXT NOT NULL,
          source_turn_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('generating', 'completed', 'failed')),
          presentation_source TEXT
            CHECK(presentation_source IS NULL OR presentation_source IN ('model', 'fallback')),
          message_id TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 1,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(source_turn_id) REFERENCES companion_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES companion_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_companion_agent_result_proposal
          ON companion_agent_result_presentations(proposal_id, updated_at DESC);
      `);
    },
  },
  {
    version: 7,
    name: "agent_proposal_outbox",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_agent_proposal_outbox (
          id TEXT PRIMARY KEY,
          source_turn_id TEXT NOT NULL UNIQUE,
          assistant_message_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'dispatching', 'delivered', 'failed')),
          proposal_id TEXT UNIQUE,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(source_turn_id) REFERENCES companion_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(assistant_message_id) REFERENCES companion_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_companion_agent_proposal_outbox_recovery
          ON companion_agent_proposal_outbox(state, created_at);
      `);
    },
  },
];
