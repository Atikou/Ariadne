import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applySqliteMigrations,
  assertDatabaseVersionSupported,
  getSchemaInfo,
  type SchemaInfo,
} from "../storage/sqliteMigration.js";
import {
  COMPANION_DB_MIGRATIONS,
  COMPANION_DB_SCHEMA_VERSION,
} from "./companionDbMigrations.js";
import {
  CompanionAgentResultPresentationRepository,
  type CompanionAgentResultPresentationCompletion,
  type CompanionAgentResultProjectionClaim,
  type CompanionAgentResultProjectionIdentity,
} from "./CompanionAgentResultPresentationRepository.js";
import type { AgentProposal } from "../assistant/AgentHandoffContracts.js";
import {
  CompanionAgentProposalOutboxRepository,
  type CompanionAgentProposalOutboxClaim,
  type CompanionAgentProposalOutboxEnqueueInput,
  type CompanionAgentProposalOutboxEntry,
} from "./CompanionAgentProposalOutboxRepository.js";
import {
  serializeCompanionMessageEnvelope,
  mapCompanionMessageRow,
  type CompanionMessageRow,
} from "./CompanionMessagePersistence.js";
import { CompanionMemoryDeletionRepository } from "./CompanionMemoryDeletionRepository.js";
import { CompanionPersonaRepository } from "./CompanionPersonaRepository.js";
import { CompanionSessionDeletionRepository } from "./CompanionSessionDeletionRepository.js";
import { CompanionSessionRepository } from "./CompanionSessionRepository.js";
import {
  CompanionMemoryCandidateSchema,
  CompanionMemorySchema,
  type CompanionMemory,
  type CompanionMemoryCandidate,
  type CompanionMemoryDeletionPersistence,
  type CompanionMemoryKind,
  type CompanionMemoryStatus,
  type CompanionOutputMode,
} from "./CompanionMemoryContracts.js";
import {
  CompanionStorageStatusSchema,
  CompanionSummarySchema,
  type CompanionSessionDeletionPersistence,
  type CompanionSessionDeletionStats,
} from "./CompanionSessionContracts.js";
import type {
  CompanionMessage,
  CompanionMessageRole,
  CompanionMessageStatus,
  CompanionPersona,
  CompanionPersonaVersion,
  CompanionSession,
  CompanionStorageStatus,
  CompanionSummary,
  CompanionVectorItem,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function mapSummary(row: {
  id: string;
  session_id: string;
  source_message_start_id: string;
  source_message_end_id: string;
  summary: string;
  topics_json: string;
  trust_level: "generated";
  model_name: string | null;
  created_at: string;
}): CompanionSummary {
  return CompanionSummarySchema.parse({
    id: row.id,
    sessionId: row.session_id,
    sourceMessageStartId: row.source_message_start_id,
    sourceMessageEndId: row.source_message_end_id,
    summary: row.summary,
    topics: parseStringArray(row.topics_json),
    trustLevel: row.trust_level,
    modelName: row.model_name ?? undefined,
    createdAt: row.created_at,
  });
}

function mapMemoryCandidate(row: {
  id: string;
  session_id: string | null;
  source_message_id: string | null;
  kind: string;
  key: string | null;
  value: string;
  summary: string;
  status: string;
  output_mode: string;
  reason: string | null;
  sensitivity: string;
  created_at: string;
  updated_at: string;
}): CompanionMemoryCandidate {
  return CompanionMemoryCandidateSchema.parse({
    id: row.id,
    sessionId: row.session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    kind: row.kind,
    key: row.key ?? undefined,
    value: row.value,
    summary: row.summary,
    status: row.status,
    outputMode: row.output_mode,
    reason: row.reason ?? undefined,
    sensitivity: row.sensitivity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMemory(row: {
  id: string;
  candidate_id: string | null;
  session_id: string | null;
  kind: string;
  key: string | null;
  value: string;
  summary: string;
  status: string;
  output_mode: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
}): CompanionMemory {
  return CompanionMemorySchema.parse({
    id: row.id,
    candidateId: row.candidate_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    kind: row.kind,
    key: row.key ?? undefined,
    value: row.value,
    summary: row.summary,
    status: row.status,
    outputMode: row.output_mode,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapVectorItem(row: {
  id: string;
  source_type: "memory" | "summary";
  source_id: string;
  output_mode: CompanionOutputMode;
  content: string;
  summary: string | null;
  indexed_at: string;
}): CompanionVectorItem {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    outputMode: row.output_mode,
    content: row.content,
    summary: row.summary ?? undefined,
    indexedAt: row.indexed_at,
  };
}

export class CompanionStorage {
  readonly storageRoot: string;
  readonly dbPath: string;
  readonly schemaVersion: number;
  readonly schemaInfo: SchemaInfo;
  private readonly db: DatabaseSync;
  private readonly agentProposalOutbox: CompanionAgentProposalOutboxRepository;
  private readonly agentResultPresentations: CompanionAgentResultPresentationRepository;
  private readonly memoryDeletions: CompanionMemoryDeletionRepository;
  private readonly personas: CompanionPersonaRepository;
  private readonly sessions: CompanionSessionRepository;
  private readonly sessionDeletions: CompanionSessionDeletionRepository;
  private closed = false;

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
    mkdirSync(storageRoot, { recursive: true });
    mkdirSync(path.join(storageRoot, "exports"), { recursive: true });
    this.assertWritable();
    this.dbPath = path.join(storageRoot, "companion.db");
    this.db = new DatabaseSync(this.dbPath);
    assertDatabaseVersionSupported(this.db, COMPANION_DB_SCHEMA_VERSION);
    this.agentProposalOutbox = new CompanionAgentProposalOutboxRepository(
      this.db,
      this.storageRoot,
    );
    this.agentResultPresentations = new CompanionAgentResultPresentationRepository(
      this.db,
      this.storageRoot,
    );
    this.memoryDeletions = new CompanionMemoryDeletionRepository(this.db);
    this.personas = new CompanionPersonaRepository(this.db);
    this.sessions = new CompanionSessionRepository(this.db, this.storageRoot);
    this.sessionDeletions = new CompanionSessionDeletionRepository(this.db);
    try {
      this.db.exec("PRAGMA journal_mode = DELETE;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      const { version } = applySqliteMigrations(this.db, COMPANION_DB_MIGRATIONS);
      this.schemaVersion = version;
      this.schemaInfo = getSchemaInfo(this.db);
      if (version !== COMPANION_DB_SCHEMA_VERSION) {
        throw new Error(`companion.db schema 版本异常：期望 ${COMPANION_DB_SCHEMA_VERSION}，实际 ${version}`);
      }
      this.personas.assertDefaultInvariant();
      this.recoverStreamingMessages();
      this.agentProposalOutbox.recover();
      this.agentResultPresentations.recover();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error; this instance is never published.
      }
      this.closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  status(): CompanionStorageStatus {
    return CompanionStorageStatusSchema.parse({
      storageRoot: this.storageRoot,
      dbPath: this.dbPath,
      schemaVersion: this.schemaVersion,
      writable: true,
    });
  }

  createSession(input?: {
    id?: string;
    personaId?: string;
    title?: string;
    incognito?: boolean;
  }): CompanionSession {
    return this.sessions.create(input);
  }

  getSession(id: string): CompanionSession | null {
    return this.sessions.get(id);
  }

  listSessions(limit = 50): CompanionSession[] {
    return this.sessions.list(limit);
  }

  updateSessionTitle(id: string, title: string): CompanionSession | null {
    return this.sessions.updateTitle(id, title);
  }

  deleteSession(id: string): CompanionSessionDeletionStats | null {
    return this.sessionDeletions.deleteSession(id)?.deletions.primary ?? null;
  }

  deleteSessionAcrossStores(
    id: string,
    unrestrictedDbPath: string,
  ) {
    return this.sessionDeletions.deleteSession(id, unrestrictedDbPath);
  }

  touchSession(sessionId: string, patch?: { title?: string; lastSummaryMessageId?: string }): void {
    this.sessions.touch(sessionId, patch);
  }

  createMessage(input: {
    id?: string;
    sessionId: string;
    role: CompanionMessageRole;
    content: string;
    status?: CompanionMessageStatus;
    memoryEligible?: boolean;
    modelName?: string;
    clientName?: string;
    metadata?: Record<string, unknown>;
  }): CompanionMessage {
    const id = input.id ?? crypto.randomUUID();
    const at = nowIso();
    const status = input.status ?? "completed";
    this.db
      .prepare(
        `INSERT INTO companion_messages
          (id, session_id, role, content, status, content_envelope_json, memory_eligible, model_name, client_name, storage_root, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.role,
        input.content,
        status,
        serializeCompanionMessageEnvelope(input.role, status, id),
        input.memoryEligible === false ? 0 : 1,
        input.modelName ?? null,
        input.clientName ?? null,
        this.storageRoot,
        at,
        at,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    this.touchSession(input.sessionId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): CompanionMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_messages WHERE id=?`)
      .get(id) as CompanionMessageRow | undefined;
    return row ? mapCompanionMessageRow(row) : null;
  }

  updateMessage(
    id: string,
    patch: {
      content?: string;
      status?: CompanionMessageStatus;
      modelName?: string;
      clientName?: string;
      metadata?: Record<string, unknown>;
    },
  ): CompanionMessage | null {
    const current = this.getMessage(id);
    if (!current) return null;
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE companion_messages
         SET content=?, status=?, model_name=?, client_name=?, updated_at=?, metadata_json=?,
             content_envelope_json=?
         WHERE id=?`,
      )
      .run(
        patch.content ?? current.content,
        patch.status ?? current.status,
        patch.modelName ?? current.modelName ?? null,
        patch.clientName ?? current.clientName ?? null,
        at,
        patch.metadata ? JSON.stringify(patch.metadata) : current.metadata ? JSON.stringify(current.metadata) : null,
        serializeCompanionMessageEnvelope(current.role, patch.status ?? current.status, id),
        id,
      );
    this.touchSession(current.sessionId);
    return this.getMessage(id);
  }

  /** Finalizes a draft exactly once. A late completion cannot overwrite an interruption. */
  finalizeStreamingMessage(
    id: string,
    patch: {
      content: string;
      status: "completed" | "interrupted";
      modelName?: string;
      clientName?: string;
      metadata?: Record<string, unknown>;
    },
  ): CompanionMessage | null {
    const current = this.getMessage(id);
    if (!current || current.status !== "streaming") return null;
    const at = nowIso();
    const result = this.db
      .prepare(
        `UPDATE companion_messages
         SET content=?, status=?, model_name=?, client_name=?, updated_at=?, metadata_json=?,
             content_envelope_json=?
         WHERE id=? AND status='streaming'`,
      )
      .run(
        patch.content,
        patch.status,
        patch.modelName ?? current.modelName ?? null,
        patch.clientName ?? current.clientName ?? null,
        at,
        patch.metadata ? JSON.stringify(patch.metadata) : current.metadata ? JSON.stringify(current.metadata) : null,
        serializeCompanionMessageEnvelope(current.role, patch.status, id),
        id,
      );
    if (Number(result.changes) !== 1) return null;
    this.touchSession(current.sessionId);
    return this.getMessage(id);
  }

  private recoverStreamingMessages(): void {
    const rows = this.db
      .prepare(`SELECT id, metadata_json FROM companion_messages WHERE status='streaming'`)
      .all() as Array<{ id: string; metadata_json: string | null }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(
       `UPDATE companion_messages SET status='interrupted', updated_at=?, metadata_json=?,
          content_envelope_json=?
        WHERE id=? AND status='streaming'`,
    );
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        update.run(at, JSON.stringify({
          ...(parseJsonObject(row.metadata_json) ?? {}),
          interruptionCode: "service_restarted",
          recoveredAt: at,
        }), serializeCompanionMessageEnvelope("assistant", "interrupted", row.id), row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listMessages(sessionId: string, limit = 80): CompanionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM companion_messages
           WHERE session_id=? AND status != 'deleted'
           ORDER BY created_at DESC
           LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, limit) as unknown as CompanionMessageRow[];
    return rows.map(mapCompanionMessageRow);
  }

  enqueueAgentProposalOutbox(
    input: CompanionAgentProposalOutboxEnqueueInput,
  ): CompanionAgentProposalOutboxEntry {
    return this.agentProposalOutbox.enqueue(input);
  }

  claimAgentProposalOutbox(id: string): CompanionAgentProposalOutboxClaim {
    return this.agentProposalOutbox.claim(id);
  }

  completeAgentProposalOutbox(
    id: string,
    proposal: AgentProposal,
  ): { proposal: AgentProposal; assistantMessage: CompanionMessage } {
    return this.agentProposalOutbox.complete(id, proposal);
  }

  failAgentProposalOutbox(id: string, errorCode: string): void {
    this.agentProposalOutbox.fail(id, errorCode);
  }

  listRecoverableAgentProposalOutboxIds(limit = 50): string[] {
    return this.agentProposalOutbox.recoverableIds(limit);
  }

  claimAgentResultPresentation(
    input: CompanionAgentResultProjectionIdentity,
  ): CompanionAgentResultProjectionClaim {
    return this.agentResultPresentations.claim(input);
  }

  completeAgentResultPresentation(
    input: CompanionAgentResultPresentationCompletion,
  ): CompanionMessage {
    return this.agentResultPresentations.complete(input);
  }

  failAgentResultPresentation(projectionKey: string, errorCode: string): void {
    this.agentResultPresentations.fail(projectionKey, errorCode);
  }

  createSummary(input: {
    sessionId: string;
    sourceMessageStartId: string;
    sourceMessageEndId: string;
    summary: string;
    topics?: string[];
    modelName?: string;
  }): CompanionSummary {
    const id = crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_summaries
          (id, session_id, source_message_start_id, source_message_end_id, summary, topics_json, trust_level, model_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.sourceMessageStartId,
        input.sourceMessageEndId,
        input.summary,
        JSON.stringify(input.topics ?? []),
        input.modelName ?? null,
        at,
      );
    this.touchSession(input.sessionId, { lastSummaryMessageId: input.sourceMessageEndId });
    return this.getSummary(id)!;
  }

  getSummary(id: string): CompanionSummary | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_summaries WHERE id=?`)
      .get(id) as Parameters<typeof mapSummary>[0] | undefined;
    return row ? mapSummary(row) : null;
  }

  listSummaries(sessionId: string, limit = 6): CompanionSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_summaries WHERE session_id=? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, limit) as Array<Parameters<typeof mapSummary>[0]>;
    return rows.map(mapSummary).reverse();
  }

  listAllSummaries(limit = 500): CompanionSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_summaries ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Parameters<typeof mapSummary>[0]>;
    return rows.map(mapSummary);
  }

  listPersonas(options?: { includeInactive?: boolean }): CompanionPersona[] {
    return this.personas.list(options);
  }

  getPersona(id: string): CompanionPersona | null {
    return this.personas.get(id);
  }

  createPersona(input: {
    id?: string;
    name: string;
    systemPrompt: string;
    description?: string;
  }): CompanionPersona {
    return this.personas.create(input);
  }

  updatePersona(
    id: string,
    patch: { name?: string; systemPrompt?: string; description?: string; active?: boolean },
  ): CompanionPersona | null {
    return this.personas.update(id, patch);
  }

  deletePersona(id: string): boolean {
    return this.personas.delete(id);
  }

  listPersonaVersions(personaId: string): CompanionPersonaVersion[] {
    return this.personas.listVersions(personaId);
  }

  revertPersona(personaId: string, version: number): CompanionPersona | null {
    return this.personas.revert(personaId, version);
  }

  createMemoryCandidate(input: {
    id?: string;
    sessionId?: string;
    sourceMessageId?: string;
    kind: CompanionMemoryKind;
    key?: string;
    value: string;
    summary?: string;
    outputMode?: CompanionOutputMode;
    reason?: string;
    sensitivity?: "low" | "medium" | "high" | "critical";
    status?: CompanionMemoryStatus;
  }): CompanionMemoryCandidate {
    const id = input.id ?? crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_memory_candidates
          (id, session_id, source_message_id, kind, key, value, summary, status, output_mode, reason, sensitivity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.sourceMessageId ?? null,
        input.kind,
        input.key ?? null,
        input.value,
        input.summary ?? input.value,
        input.status ?? "candidate",
        input.outputMode ?? "bounded",
        input.reason ?? null,
        input.sensitivity ?? "low",
        at,
        at,
      );
    return this.getMemoryCandidate(id)!;
  }

  getMemoryCandidate(id: string): CompanionMemoryCandidate | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_memory_candidates WHERE id=?`)
      .get(id) as Parameters<typeof mapMemoryCandidate>[0] | undefined;
    return row ? mapMemoryCandidate(row) : null;
  }

  listMemoryCandidates(filter?: {
    status?: CompanionMemoryStatus;
    outputMode?: CompanionOutputMode;
    sessionId?: string;
    limit?: number;
  }): CompanionMemoryCandidate[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter?.status) {
      clauses.push("status=?");
      args.push(filter.status);
    }
    if (filter?.outputMode) {
      clauses.push("output_mode=?");
      args.push(filter.outputMode);
    }
    if (filter?.sessionId) {
      clauses.push("session_id=?");
      args.push(filter.sessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM companion_memory_candidates ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, filter?.limit ?? 100) as Array<Parameters<typeof mapMemoryCandidate>[0]>;
    return rows.map(mapMemoryCandidate);
  }

  updateMemoryCandidate(
    id: string,
    patch: Partial<Pick<CompanionMemoryCandidate, "status" | "kind" | "key" | "value" | "summary" | "reason" | "sensitivity">>,
  ): CompanionMemoryCandidate | null {
    const current = this.getMemoryCandidate(id);
    if (!current) return null;
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE companion_memory_candidates
         SET kind=?, key=?, value=?, summary=?, status=?, reason=?, sensitivity=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        patch.kind ?? current.kind,
        patch.key ?? current.key ?? null,
        patch.value ?? current.value,
        patch.summary ?? current.summary,
        patch.status ?? current.status,
        patch.reason ?? current.reason ?? null,
        patch.sensitivity ?? current.sensitivity,
        at,
        id,
      );
    return this.getMemoryCandidate(id);
  }

  createMemory(input: {
    id?: string;
    candidateId?: string;
    sessionId?: string;
    kind: CompanionMemoryKind;
    key?: string;
    value: string;
    summary?: string;
    status?: CompanionMemoryStatus;
    outputMode?: CompanionOutputMode;
    importance?: number;
    confidence?: number;
  }): CompanionMemory {
    const id = input.id ?? crypto.randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO companion_memories
          (id, candidate_id, session_id, kind, key, value, summary, status, output_mode, importance, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.candidateId ?? null,
        input.sessionId ?? null,
        input.kind,
        input.key ?? null,
        input.value,
        input.summary ?? input.value,
        input.status ?? "confirmed",
        input.outputMode ?? "bounded",
        input.importance ?? 0.6,
        input.confidence ?? 0.8,
        at,
        at,
      );
    return this.getMemory(id)!;
  }

  getMemory(id: string): CompanionMemory | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_memories WHERE id=?`)
      .get(id) as Parameters<typeof mapMemory>[0] | undefined;
    return row ? mapMemory(row) : null;
  }

  getMemoryByCandidateId(candidateId: string): CompanionMemory | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_memories WHERE candidate_id=? LIMIT 1`)
      .get(candidateId) as Parameters<typeof mapMemory>[0] | undefined;
    return row ? mapMemory(row) : null;
  }

  upsertMemoryMigrationAlias(input: {
    legacyId: string;
    recordType: "memory" | "candidate";
    targetId: string;
  }): void {
    this.db.prepare(
      `INSERT INTO companion_memory_migration_aliases
        (legacy_id, record_type, target_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(legacy_id, record_type) DO UPDATE SET target_id=excluded.target_id`,
    ).run(input.legacyId, input.recordType, input.targetId, nowIso());
  }

  getMemoryMigrationAlias(
    legacyId: string,
    recordType: "memory" | "candidate",
  ): string | null {
    const row = this.db.prepare(
      `SELECT target_id FROM companion_memory_migration_aliases
       WHERE legacy_id=? AND record_type=?`,
    ).get(legacyId, recordType) as { target_id: string } | undefined;
    return row?.target_id ?? null;
  }

  listMemories(filter?: {
    status?: CompanionMemoryStatus;
    outputMode?: CompanionOutputMode;
    sessionId?: string;
    includeUnrestrictedForUnrestricted?: boolean;
    limit?: number;
  }): CompanionMemory[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter?.status) {
      clauses.push("status=?");
      args.push(filter.status);
    }
    if (filter?.outputMode) {
      if (filter.outputMode === "unrestricted" && filter.includeUnrestrictedForUnrestricted) {
        clauses.push("output_mode IN ('bounded', 'unrestricted')");
      } else {
        clauses.push("output_mode=?");
        args.push(filter.outputMode);
      }
    }
    if (filter?.sessionId) {
      clauses.push("(session_id IS NULL OR session_id=?)");
      args.push(filter.sessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM companion_memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, filter?.limit ?? 100) as Array<Parameters<typeof mapMemory>[0]>;
    return rows.map(mapMemory);
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<CompanionMemory, "status" | "kind" | "key" | "value" | "summary" | "importance" | "confidence">>,
  ): CompanionMemory | null {
    const current = this.getMemory(id);
    if (!current) return null;
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE companion_memories
         SET kind=?, key=?, value=?, summary=?, status=?, importance=?, confidence=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        patch.kind ?? current.kind,
        patch.key ?? current.key ?? null,
        patch.value ?? current.value,
        patch.summary ?? current.summary,
        patch.status ?? current.status,
        patch.importance ?? current.importance,
        patch.confidence ?? current.confidence,
        at,
        id,
      );
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const memory = this.updateMemory(id, { status: "deleted" });
    return memory !== null;
  }

  deleteMemoryResource(id: string): CompanionMemoryDeletionPersistence | null {
    return this.memoryDeletions.delete(id);
  }

  confirmMemoryCandidate(id: string, patch?: {
    kind?: CompanionMemoryKind;
    summary?: string;
    value?: string;
    key?: string;
    sensitivity?: CompanionMemoryCandidate["sensitivity"];
    importance?: number;
    confidence?: number;
  }): CompanionMemory | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getMemoryByCandidateId(id);
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      const candidate = this.getMemoryCandidate(id);
      if (!candidate || candidate.status !== "candidate") {
        this.db.exec("COMMIT");
        return null;
      }
      const updated = this.updateMemoryCandidate(id, {
        status: "confirmed",
        kind: patch?.kind ?? candidate.kind,
        value: patch?.value ?? candidate.value,
        summary: patch?.summary ?? candidate.summary,
        key: patch?.key ?? candidate.key,
        sensitivity: patch?.sensitivity ?? candidate.sensitivity,
      });
      if (!updated) throw new Error("companion_memory_candidate_disappeared");
      const memory = this.createMemory({
        candidateId: updated.id,
        sessionId: updated.sessionId,
        kind: updated.kind,
        key: updated.key,
        value: updated.value,
        summary: updated.summary,
        outputMode: updated.outputMode,
        importance: patch?.importance ?? 0.7,
        confidence: patch?.confidence ?? 0.9,
      });
      this.db.exec("COMMIT");
      return memory;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertVectorItem(input: {
    sourceType: "memory" | "summary";
    sourceId: string;
    outputMode?: CompanionOutputMode;
    content: string;
    summary?: string;
  }): CompanionVectorItem {
    const existing = this.getVectorItem(input.sourceType, input.sourceId);
    const at = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE companion_vector_items
           SET output_mode=?, content=?, summary=?, indexed_at=?
           WHERE source_type=? AND source_id=?`,
        )
        .run(
          input.outputMode ?? existing.outputMode,
          input.content,
          input.summary ?? null,
          at,
          input.sourceType,
          input.sourceId,
        );
      return this.getVectorItem(input.sourceType, input.sourceId)!;
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO companion_vector_items
          (id, source_type, source_id, output_mode, content, summary, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sourceType, input.sourceId, input.outputMode ?? "bounded", input.content, input.summary ?? null, at);
    return this.getVectorItem(input.sourceType, input.sourceId)!;
  }

  getVectorItem(sourceType: "memory" | "summary", sourceId: string): CompanionVectorItem | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_vector_items WHERE source_type=? AND source_id=?`)
      .get(sourceType, sourceId) as Parameters<typeof mapVectorItem>[0] | undefined;
    return row ? mapVectorItem(row) : null;
  }

  listVectorItems(limit = 500): CompanionVectorItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_vector_items ORDER BY indexed_at DESC LIMIT ?`)
      .all(limit) as Array<Parameters<typeof mapVectorItem>[0]>;
    return rows.map(mapVectorItem);
  }

  countVectorItems(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM companion_vector_items`).get() as { count: number };
    return row.count;
  }

  deleteVectorItem(sourceType: "memory" | "summary", sourceId: string): void {
    this.db.prepare(`DELETE FROM companion_vector_items WHERE source_type=? AND source_id=?`).run(sourceType, sourceId);
  }

  clearVectorItems(): void {
    this.db.prepare(`DELETE FROM companion_vector_items`).run();
  }

  private assertWritable(): void {
    const probe = path.join(this.storageRoot, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", "utf-8");
    rmSync(probe, { force: true });
  }

}
