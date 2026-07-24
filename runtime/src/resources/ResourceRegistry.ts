import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

export type ResourceLifecycle = "temporary" | "session" | "run" | "persistent";
export type ResourceSensitivity = "public" | "workspace" | "sensitive" | "secret";

export interface ResourceRecord {
  resourceId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  hash: string;
  lifecycle: ResourceLifecycle;
  sensitivity: ResourceSensitivity;
  owner: { type: string; id: string };
  provenance: { origin: string; sourceId?: string; summary?: string };
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterResourceInput {
  name: string;
  mediaType: string;
  bytes: Buffer;
  owner: { type: string; id: string };
  lifecycle: ResourceLifecycle;
  sensitivity: ResourceSensitivity;
  provenance: ResourceRecord["provenance"];
  expiresAt?: string;
}

export interface UpdateResourceInput {
  name?: string;
  lifecycle?: ResourceLifecycle;
  sensitivity?: ResourceSensitivity;
  provenanceSummary?: string | null;
  expiresAt?: string | null;
}

/** Content-addressed resource ownership registry. Public records never contain local paths. */
export class ResourceRegistry {
  private readonly objectsRoot: string;

  constructor(
    private readonly db: DatabaseSync,
    dataDir: string,
  ) {
    this.objectsRoot = path.join(dataDir, "agent_data", "resources", "objects");
  }

  async registerBytes(input: RegisterResourceInput): Promise<ResourceRecord> {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const relativePath = path.posix.join(hash.slice(0, 2), hash);
    const absolutePath = this.resolveObjectPath(relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, input.bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO resources (
         id, sha256, name, media_type, size_bytes, owner_type, owner_id,
         lifecycle, sensitivity, provenance_json, relative_path,
         expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      hash,
      input.name,
      input.mediaType,
      input.bytes.byteLength,
      input.owner.type,
      input.owner.id,
      input.lifecycle,
      input.sensitivity,
      JSON.stringify(input.provenance),
      relativePath,
      input.expiresAt ?? null,
      now,
      now,
    );
    return this.require(id);
  }

  get(resourceId: string): ResourceRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM resources WHERE id=?`,
    ).get(resourceId) as ResourceRow | undefined;
    return row ? project(row) : undefined;
  }

  require(resourceId: string): ResourceRecord {
    const record = this.get(resourceId);
    if (!record) throw new Error(`resource_not_found:${resourceId}`);
    return record;
  }

  list(input: {
    ownerType?: string;
    ownerId?: string;
    includeExpired?: boolean;
    limit?: number;
  } = {}): ResourceRecord[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (input.ownerType) {
      conditions.push("owner_type=?");
      params.push(input.ownerType);
    }
    if (input.ownerId) {
      conditions.push("owner_id=?");
      params.push(input.ownerId);
    }
    if (!input.includeExpired) {
      conditions.push("(expires_at IS NULL OR expires_at>?)");
      params.push(new Date().toISOString());
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(input.limit ?? 200, 2_000)));
    const rows = this.db.prepare(
      `SELECT * FROM resources ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as unknown as ResourceRow[];
    return rows.map(project);
  }

  async readBytes(resourceId: string): Promise<Buffer> {
    const row = this.db.prepare(
      `SELECT relative_path FROM resources WHERE id=?`,
    ).get(resourceId) as { relative_path: string } | undefined;
    if (!row) throw new Error(`resource_not_found:${resourceId}`);
    return readFile(this.resolveObjectPath(row.relative_path));
  }

  update(resourceId: string, input: UpdateResourceInput): ResourceRecord | undefined {
    const existing = this.get(resourceId);
    if (!existing) return undefined;
    const nextProvenance = input.provenanceSummary === undefined
      ? existing.provenance
      : {
          ...existing.provenance,
          ...(input.provenanceSummary === null
            ? { summary: undefined }
            : { summary: input.provenanceSummary }),
        };
    if (input.provenanceSummary === null) delete nextProvenance.summary;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE resources
       SET name=?, lifecycle=?, sensitivity=?, provenance_json=?, expires_at=?, updated_at=?
       WHERE id=?`,
    ).run(
      input.name ?? existing.name,
      input.lifecycle ?? existing.lifecycle,
      input.sensitivity ?? existing.sensitivity,
      JSON.stringify(nextProvenance),
      input.expiresAt === undefined ? existing.expiresAt ?? null : input.expiresAt,
      now,
      resourceId,
    );
    return this.require(resourceId);
  }

  async delete(resourceId: string): Promise<boolean> {
    const row = this.db.prepare(
      `SELECT sha256, relative_path FROM resources WHERE id=?`,
    ).get(resourceId) as { sha256: string; relative_path: string } | undefined;
    if (!row) return false;
    this.db.prepare(`DELETE FROM resources WHERE id=?`).run(resourceId);
    const remaining = this.db.prepare(
      `SELECT COUNT(*) AS count FROM resources WHERE sha256=?`,
    ).get(row.sha256) as { count: number };
    if (remaining.count === 0) {
      await rm(this.resolveObjectPath(row.relative_path), { force: true });
    }
    return true;
  }

  async deleteExpired(now = new Date().toISOString()): Promise<number> {
    const ids = this.db.prepare(
      `SELECT id FROM resources WHERE expires_at IS NOT NULL AND expires_at<=?`,
    ).all(now) as Array<{ id: string }>;
    for (const row of ids) await this.delete(row.id);
    return ids.length;
  }

  private resolveObjectPath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/gu, "/");
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(normalized)) {
      throw new Error("resource_object_path_invalid");
    }
    const resolved = path.resolve(this.objectsRoot, normalized);
    const relative = path.relative(path.resolve(this.objectsRoot), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("resource_object_path_escape");
    }
    return resolved;
  }
}

interface ResourceRow {
  id: string;
  sha256: string;
  name: string;
  media_type: string;
  size_bytes: number;
  owner_type: string;
  owner_id: string;
  lifecycle: ResourceLifecycle;
  sensitivity: ResourceSensitivity;
  provenance_json: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function project(row: ResourceRow): ResourceRecord {
  return {
    resourceId: row.id,
    name: row.name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    hash: row.sha256,
    lifecycle: row.lifecycle,
    sensitivity: row.sensitivity,
    owner: { type: row.owner_type, id: row.owner_id },
    provenance: JSON.parse(row.provenance_json) as ResourceRecord["provenance"],
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
