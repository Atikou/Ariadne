import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { matchesTagFilter } from "./contextTags.js";
import { EMBEDDING_DIMENSION } from "./EmbeddingService.js";
import type { MemoryScope, SemanticItem } from "./types.js";

export interface VectorSearchFilter {
  scope?: MemoryScope;
  scopeId?: string;
  itemType?: SemanticItem["itemType"];
  /** At least one requested tag must match. */
  tags?: string[];
}

export interface VectorStoreStatus {
  backend: "memory" | "lancedb";
  persistent: boolean;
  degraded: boolean;
  requiresRebuild: boolean;
  activeTable?: string;
  reason?: string;
}

export interface VectorStore {
  addItem(item: SemanticItem): Promise<void>;
  search(queryVector: number[], filter: VectorSearchFilter | undefined, topK: number): Promise<SemanticItem[]>;
  deleteItem(id: string): Promise<void>;
  deleteBySource(sourceId: string): Promise<void>;
  updateItem(item: SemanticItem): Promise<void>;
  /** Build a new complete generation, then switch the active pointer. */
  replaceAll(items: SemanticItem[]): Promise<void>;
  status(): VectorStoreStatus;
}

type LanceRow = {
  id: string;
  item_type: string;
  scope: string;
  scope_id: string;
  source_id: string;
  content: string;
  summary: string;
  vector: Float32Array;
  tags: string;
  created_at: string;
  updated_at: string;
};

/** In-memory index used explicitly by tests and as a non-persistent runtime fallback. */
export class InMemoryVectorStore implements VectorStore {
  private readonly items = new Map<string, SemanticItem>();

  async addItem(item: SemanticItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    const scored: Array<{ item: SemanticItem; score: number }> = [];
    for (const item of this.items.values()) {
      if (filter?.scope && item.scope !== filter.scope) continue;
      if (filter?.scopeId && item.scopeId !== filter.scopeId) continue;
      if (filter?.itemType && item.itemType !== filter.itemType) continue;
      if (!matchesTagFilter(item.tags, filter?.tags)) continue;
      scored.push({ item, score: cosineSimilarity(queryVector, item.vector) });
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, Math.max(0, topK)).map(({ item }) => item);
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }

  async deleteBySource(sourceId: string): Promise<void> {
    for (const [id, item] of this.items) {
      if (item.sourceId === sourceId) this.items.delete(id);
    }
  }

  async updateItem(item: SemanticItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async replaceAll(items: SemanticItem[]): Promise<void> {
    this.items.clear();
    for (const item of items) this.items.set(item.id, item);
  }

  status(): VectorStoreStatus {
    return {
      backend: "memory",
      persistent: false,
      degraded: false,
      requiresRebuild: false,
      reason: "in_memory_index",
    };
  }

  listAll(): SemanticItem[] {
    return [...this.items.values()];
  }
}

function isLanceRecoverableError(error: unknown): boolean {
  return /vector column|dimension|query stream|GenericFailure|panicked|arrow-data|Invalid input|schema/i.test(
    String(error),
  );
}

/**
 * Persistent LanceDB index with generation switching.
 *
 * Online failures never drop an index table. A damaged/incompatible generation is retained for
 * diagnosis, a fresh generation becomes active, and status requires an explicit full rebuild.
 */
export class LanceDbVectorStore implements VectorStore {
  private tablePromise: Promise<import("@lancedb/lancedb").Table> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly fallback = new InMemoryVectorStore();
  private readonly pointerPath: string;
  private state: VectorStoreStatus = {
    backend: "lancedb",
    persistent: true,
    degraded: false,
    requiresRebuild: false,
  };

  constructor(
    private readonly lanceDir: string,
    private readonly vectorDim: number = EMBEDDING_DIMENSION,
  ) {
    mkdirSync(lanceDir, { recursive: true });
    this.pointerPath = path.join(lanceDir, "active-index.json");
  }

  status(): VectorStoreStatus {
    return { ...this.state };
  }

  async addItem(item: SemanticItem): Promise<void> {
    await this.runExclusive(async () => this.persistUpsert(item));
  }

  async updateItem(item: SemanticItem): Promise<void> {
    await this.runExclusive(async () => this.persistUpsert(item));
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    assertVectorDimension(queryVector, this.vectorDim);
    await this.mutationQueue;
    try {
      const persistent = await this.searchInner(toFloatVector(queryVector), filter, topK);
      const transient = await this.fallback.search(queryVector, filter, topK);
      return mergeUnique(persistent, transient).slice(0, Math.max(0, topK));
    } catch (error) {
      await this.handleReadFailure(error);
      return this.fallback.search(queryVector, filter, topK);
    }
  }

  async deleteItem(id: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.fallback.deleteItem(id);
      try {
        const table = await this.getTable();
        await table.delete(`id = '${escapeSqlLiteral(id)}'`);
      } catch (error) {
        await this.handleMutationFailure(error);
      }
    });
  }

  async deleteBySource(sourceId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.fallback.deleteBySource(sourceId);
      try {
        const table = await this.getTable();
        await table.delete(`source_id = '${escapeSqlLiteral(sourceId)}'`);
      } catch (error) {
        await this.handleMutationFailure(error);
      }
    });
  }

  async replaceAll(items: SemanticItem[]): Promise<void> {
    for (const item of items) assertVectorDimension(item.vector, this.vectorDim);
    await this.runExclusive(async () => {
      try {
        const db = await this.getDb();
        const tableName = generationName(this.vectorDim);
        const table = await this.createTable(db, tableName, items.map((item) => toRow(item)));
        if (!(await this.validateTableHealth(table))) {
          throw new Error(`new vector generation ${tableName} failed health validation`);
        }
        await this.writeActivePointer(tableName);
        this.tablePromise = Promise.resolve(table);
        this.state = {
          backend: "lancedb",
          persistent: true,
          degraded: false,
          requiresRebuild: false,
          activeTable: tableName,
        };
        await this.fallback.replaceAll([]);
      } catch (error) {
        await this.fallback.replaceAll(items);
        this.markDegraded(error, false);
      }
    });
  }

  private async persistUpsert(item: SemanticItem): Promise<void> {
    assertVectorDimension(item.vector, this.vectorDim);
    try {
      const table = await this.getTable();
      await table.delete(`id = '${escapeSqlLiteral(item.id)}'`);
      await table.add([toRow(item)]);
      await this.fallback.deleteItem(item.id);
    } catch (error) {
      await this.fallback.updateItem(item);
      await this.handleMutationFailure(error, item);
    }
  }

  private async searchInner(
    queryVector: Float32Array,
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    const table = await this.getTable();
    let query = table.vectorSearch(queryVector).limit(Math.max(1, topK));
    const clauses: string[] = [];
    if (filter?.scope) clauses.push(`scope = '${escapeSqlLiteral(filter.scope)}'`);
    if (filter?.scopeId) clauses.push(`scope_id = '${escapeSqlLiteral(filter.scopeId)}'`);
    if (filter?.itemType) clauses.push(`item_type = '${escapeSqlLiteral(filter.itemType)}'`);
    if (clauses.length > 0) query = query.where(clauses.join(" AND "));
    const rows = (await query.toArray()) as unknown as LanceRow[];
    return rows.map(fromRow).filter((item) => matchesTagFilter(item.tags, filter?.tags));
  }

  private async getTable(): Promise<import("@lancedb/lancedb").Table> {
    this.tablePromise ??= this.openActiveTable();
    return this.tablePromise;
  }

  private async openActiveTable(): Promise<import("@lancedb/lancedb").Table> {
    const db = await this.getDb();
    const names = await db.tableNames();
    const pointer = await this.readActivePointer();
    const candidates = [...new Set([pointer.tableName, "semantic_items"].filter((name): name is string => Boolean(name)))];
    let invalidTable = pointer.incompatibleTable;
    for (const tableName of candidates) {
      if (!names.includes(tableName)) continue;
      const table = await db.openTable(tableName);
      if (await this.validateTableHealth(table)) {
        await this.writeActivePointer(tableName);
        this.state = {
          backend: "lancedb",
          persistent: true,
          degraded: false,
          requiresRebuild: false,
          activeTable: tableName,
        };
        return table;
      }
      invalidTable = tableName;
    }

    const tableName = generationName(this.vectorDim);
    const table = await this.createTable(db, tableName, []);
    await this.writeActivePointer(tableName);
    this.state = {
      backend: "lancedb",
      persistent: true,
      degraded: Boolean(invalidTable),
      requiresRebuild: Boolean(invalidTable),
      activeTable: tableName,
      reason: invalidTable ? `retained_incompatible_generation:${invalidTable}` : undefined,
    };
    return table;
  }

  private async createTable(
    db: import("@lancedb/lancedb").Connection,
    tableName: string,
    rows: LanceRow[],
  ): Promise<import("@lancedb/lancedb").Table> {
    const seed = schemaSeed(this.vectorDim);
    const table = await db.createTable(tableName, rows.length > 0 ? rows : [seed]);
    if (rows.length === 0) await table.delete(`id = '${seed.id}'`);
    return table;
  }

  private async validateTableHealth(table: import("@lancedb/lancedb").Table): Promise<boolean> {
    try {
      await table.query().limit(1).toArray();
      await table.vectorSearch(new Float32Array(this.vectorDim)).limit(1).toArray();
      return true;
    } catch {
      return false;
    }
  }

  private async handleReadFailure(error: unknown): Promise<void> {
    this.markDegraded(error, isLanceRecoverableError(error));
    if (!isLanceRecoverableError(error)) return;
    await this.runExclusive(async () => this.activateRecoveryGeneration(error));
  }

  private async handleMutationFailure(error: unknown, retainedItem?: SemanticItem): Promise<void> {
    this.markDegraded(error, isLanceRecoverableError(error));
    if (!isLanceRecoverableError(error)) return;
    await this.activateRecoveryGeneration(error);
    if (retainedItem) {
      try {
        const table = await this.getTable();
        await table.add([toRow(retainedItem)]);
        await this.fallback.deleteItem(retainedItem.id);
      } catch (retryError) {
        this.markDegraded(retryError, false);
      }
    }
  }

  private async activateRecoveryGeneration(cause: unknown): Promise<void> {
    try {
      const previous = this.state.activeTable;
      const db = await this.getDb();
      const tableName = generationName(this.vectorDim);
      const table = await this.createTable(db, tableName, []);
      await this.writeActivePointer(tableName);
      this.tablePromise = Promise.resolve(table);
      this.state = {
        backend: "lancedb",
        persistent: true,
        degraded: true,
        requiresRebuild: true,
        activeTable: tableName,
        reason: `retained_failed_generation:${previous ?? "unknown"};${errorReason(cause)}`,
      };
    } catch (recoveryError) {
      this.tablePromise = null;
      this.markDegraded(recoveryError, true);
    }
  }

  private markDegraded(error: unknown, requiresRebuild: boolean): void {
    this.state = {
      ...this.state,
      backend: "lancedb",
      persistent: false,
      degraded: true,
      requiresRebuild: this.state.requiresRebuild || requiresRebuild,
      reason: errorReason(error),
    };
  }

  private async getDb(): Promise<import("@lancedb/lancedb").Connection> {
    const lancedb = await import("@lancedb/lancedb");
    return lancedb.connect(this.lanceDir);
  }

  private async readActivePointer(): Promise<{ tableName?: string; incompatibleTable?: string }> {
    try {
      const parsed = JSON.parse(await readFile(this.pointerPath, "utf8")) as {
        tableName?: unknown;
        vectorDim?: unknown;
      };
      if (typeof parsed.tableName !== "string") return {};
      if (parsed.vectorDim !== this.vectorDim) return { incompatibleTable: parsed.tableName };
      return { tableName: parsed.tableName };
    } catch {
      return {};
    }
  }

  private async writeActivePointer(tableName: string): Promise<void> {
    const tempPath = `${this.pointerPath}.${randomUUID()}.tmp`;
    await writeFile(
      tempPath,
      JSON.stringify({ schemaVersion: 1, tableName, vectorDim: this.vectorDim, updatedAt: new Date().toISOString() }),
      "utf8",
    );
    await rename(tempPath, this.pointerPath);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function schemaSeed(vectorDim: number): LanceRow {
  const now = new Date().toISOString();
  return {
    id: "__schema_seed__",
    item_type: "memory",
    scope: "global",
    scope_id: "",
    source_id: "__schema_seed__",
    content: "",
    summary: "",
    vector: new Float32Array(vectorDim),
    tags: "",
    created_at: now,
    updated_at: now,
  };
}

function generationName(vectorDim: number): string {
  return `semantic_items_v2_d${vectorDim}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function toRow(item: SemanticItem): LanceRow {
  return {
    id: item.id,
    item_type: item.itemType,
    scope: item.scope,
    scope_id: item.scopeId ?? "",
    source_id: item.sourceId,
    content: item.content,
    summary: item.summary ?? "",
    vector: toFloatVector(item.vector),
    tags: (item.tags ?? []).join(","),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function fromRow(row: LanceRow): SemanticItem {
  const vector = Array.from(row.vector as Float32Array | number[]);
  const itemType = row.item_type as SemanticItem["itemType"];
  return {
    id: row.id,
    itemType,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id || undefined,
    sourceType: itemType,
    sourceId: row.source_id,
    content: row.content,
    summary: row.summary || undefined,
    vector,
    tags: row.tags ? row.tags.split(",").filter(Boolean) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFloatVector(values: number[] | Float32Array): Float32Array {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}

function assertVectorDimension(values: number[] | Float32Array, expected: number): void {
  if (values.length !== expected || Array.from(values).some((value) => !Number.isFinite(value))) {
    throw new Error(`vector_dimension_contract_violation: expected=${expected}, actual=${values.length}`);
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function mergeUnique(primary: SemanticItem[], secondary: SemanticItem[]): SemanticItem[] {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function cosineSimilarity(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return Math.max(-1, Math.min(1, dot / denominator));
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

export function createVectorStore(
  dataDir: string,
  useLance = true,
  vectorDimension = EMBEDDING_DIMENSION,
): VectorStore {
  if (!useLance) return new InMemoryVectorStore();
  return new LanceDbVectorStore(path.join(dataDir, "agent_data", "lancedb"), vectorDimension);
}
