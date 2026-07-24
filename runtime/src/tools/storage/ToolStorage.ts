import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applySqliteMigrations,
  getSchemaInfo,
  type SchemaInfo,
} from "../../storage/sqliteMigration.js";
import {
  TOOLS_DB_MIGRATIONS,
  TOOLS_DB_SCHEMA_VERSION,
} from "../../storage/toolsDbMigrations.js";

export interface FileChangeRecord {
  id: string;
  sessionId?: string;
  toolName: string;
  path: string;
  workspaceRoot?: string;
  normalizedPath?: string;
  workspaceScopeId?: string;
  grantId?: string;
  workspaceAccess?: Record<string, unknown>;
  beforeHash?: string;
  afterHash?: string;
  backupPath?: string;
  diff?: string;
  createdAt: string;
}

export interface ToolLogRecord {
  id: string;
  sessionId?: string;
  requestId?: string;
  toolName: string;
  inputJson: string;
  outputJson: string;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/**
 * 工具层持久化：tool_logs、file_changes、backups。
 * 数据库：{dataDir}/agent_data/tools.db；备份文件：{dataDir}/agent_data/backups/
 */
export class ToolStorage {
  readonly dbPath: string;
  readonly backupsRoot: string;
  readonly schemaVersion: number;
  readonly schemaInfo: SchemaInfo;
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const agentData = path.join(dataDir, "agent_data");
    this.backupsRoot = path.join(agentData, "backups");
    this.dbPath = path.join(agentData, "tools.db");
    mkdirSync(agentData, { recursive: true });
    mkdirSync(this.backupsRoot, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    const { version } = applySqliteMigrations(this.db, TOOLS_DB_MIGRATIONS);
    this.schemaVersion = version;
    this.schemaInfo = getSchemaInfo(this.db);
    if (version !== TOOLS_DB_SCHEMA_VERSION) {
      throw new Error(`tools.db schema 版本异常：期望 ${TOOLS_DB_SCHEMA_VERSION}，实际 ${version}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** 写入工具调用日志。 */
  insertToolLog(record: Omit<ToolLogRecord, "id"> & { id?: string }): string {
    const id = record.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO tool_logs
         (id, session_id, request_id, tool_name, input_json, output_json, ok, error_code, error_message, started_at, ended_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.sessionId ?? null,
        record.requestId ?? null,
        record.toolName,
        record.inputJson,
        record.outputJson,
        record.ok ? 1 : 0,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.startedAt,
        record.endedAt,
        record.durationMs,
      );
    return id;
  }

  /** 读取近期工具调用日志（用于测试、审计与调试视图）。 */
  listRecentToolLogs(limit = 50): ToolLogRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, session_id, request_id, tool_name, input_json, output_json, ok, error_code, error_message, started_at, ended_at, duration_ms
         FROM tool_logs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(safeLimit) as Array<{
      id: string;
      session_id: string | null;
      request_id: string | null;
      tool_name: string;
      input_json: string | null;
      output_json: string | null;
      ok: number;
      error_code: string | null;
      error_message: string | null;
      started_at: string;
      ended_at: string;
      duration_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id ?? undefined,
      requestId: row.request_id ?? undefined,
      toolName: row.tool_name,
      inputJson: row.input_json ?? "",
      outputJson: row.output_json ?? "",
      ok: row.ok === 1,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
    }));
  }

  /** 记录一次文件变更。 */
  insertFileChange(record: Omit<FileChangeRecord, "createdAt"> & { createdAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO file_changes
         (id, session_id, tool_name, path, workspace_root, normalized_path, workspace_scope_id, grant_id,
          workspace_access_json, before_hash, after_hash, backup_path, diff, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId ?? null,
        record.toolName,
        record.path,
        record.workspaceRoot ?? null,
        record.normalizedPath ?? null,
        record.workspaceScopeId ?? null,
        record.grantId ?? null,
        stringifyJson(record.workspaceAccess),
        record.beforeHash ?? null,
        record.afterHash ?? null,
        record.backupPath ?? null,
        record.diff ?? null,
        record.createdAt ?? new Date().toISOString(),
      );
  }

  /** 按 requestId（通常为 Run id）收集本次任务成功的写操作 changeId，按时间正序。 */
  listChangeIdsForRequest(requestId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT output_json FROM tool_logs
         WHERE request_id = ? AND ok = 1 AND tool_name IN ('write_file', 'apply_patch')
         ORDER BY started_at ASC`,
      )
      .all(requestId) as Array<{ output_json: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      try {
        const output = JSON.parse(row.output_json) as { changeId?: string };
        if (typeof output.changeId === "string" && output.changeId.length > 0) {
          ids.push(output.changeId);
        }
      } catch {
        /* 忽略无法解析的日志 */
      }
    }
    return ids;
  }

  getFileChange(changeId: string): FileChangeRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, tool_name, path, workspace_root, normalized_path, workspace_scope_id, grant_id,
                workspace_access_json, before_hash, after_hash, backup_path, diff, created_at
         FROM file_changes WHERE id = ?`,
      )
      .get(changeId) as
      | {
          id: string;
          session_id: string | null;
          tool_name: string;
          path: string;
          workspace_root: string | null;
          normalized_path: string | null;
          workspace_scope_id: string | null;
          grant_id: string | null;
          workspace_access_json: string | null;
          before_hash: string | null;
          after_hash: string | null;
          backup_path: string | null;
          diff: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id ?? undefined,
      toolName: row.tool_name,
      path: row.path,
      workspaceRoot: row.workspace_root ?? undefined,
      normalizedPath: row.normalized_path ?? undefined,
      workspaceScopeId: row.workspace_scope_id ?? undefined,
      grantId: row.grant_id ?? undefined,
      workspaceAccess: parseJsonRecord(row.workspace_access_json),
      beforeHash: row.before_hash ?? undefined,
      afterHash: row.after_hash ?? undefined,
      backupPath: row.backup_path ?? undefined,
      diff: row.diff ?? undefined,
      createdAt: row.created_at,
    };
  }

  /** 创建备份批次并复制文件到 agent_data/backups/{date}/{backupId}/。 */
  async createBackupBatch(
    workspaceRoot: string,
    relativePaths: string[],
    opts?: { reason?: string; sessionId?: string; sha256ByPath?: Map<string, string> },
  ): Promise<{ backupId: string; files: Array<{ path: string; backupPath: string; sha256: string }> }> {
    const backupId = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    const batchDir = path.join(this.backupsRoot, date, backupId);
    await mkdir(batchDir, { recursive: true });

    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO backups (id, reason, created_at) VALUES (?, ?, ?)`).run(
      backupId,
      opts?.reason ?? null,
      now,
    );

    const files: Array<{ path: string; backupPath: string; sha256: string }> = [];
    for (const rel of relativePaths) {
      const src = path.join(workspaceRoot, rel);
      const safeName = rel.replace(/[/\\]/g, "__");
      const dest = path.join(batchDir, safeName);
      await copyFile(src, dest);
      const sha256 = opts?.sha256ByPath?.get(rel) ?? "";
      const fileId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO backup_files (id, backup_id, original_path, backup_path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(fileId, backupId, rel, dest, sha256, now);
      files.push({ path: rel, backupPath: dest, sha256 });
    }
    return { backupId, files };
  }

  /** 从备份路径恢复文件到工作区。 */
  async restoreFromBackupPath(
    workspaceRoot: string,
    relativePath: string,
    backupPath: string,
  ): Promise<void> {
    const dest = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(backupPath, dest);
  }

  /** 读取备份文件内容（用于 diff_file against=backup）。 */
  async readBackupContent(backupPath: string): Promise<string> {
    return readFile(backupPath, "utf-8");
  }

  /** 写入失败时从备份恢复。 */
  async restoreFileFromBackup(backupPath: string, targetFullPath: string): Promise<void> {
    await copyFile(backupPath, targetFullPath);
  }

  /** 保存新文件内容到临时备份（新建文件场景）。 */
  async writeBackupContent(backupPath: string, content: string): Promise<void> {
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, content, "utf-8");
  }
}

function stringifyJson(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
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
