import type { DatabaseSync } from 'node:sqlite';
import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import { canonicalPublicProjectionJson,
  type PublicProjectionCatalogRow } from '@ariadne/protocol/public';
import type { SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
import { storedProjectionCatalogRow, type StoredProjectionChange } from './StoredProjectionRecords.js';

export type CatalogVersionHeader = Omit<SnapshotVersionRow, 'dto_json'>;
export const CATALOG_VERSION_HEADER_COLUMNS = 'feature, aggregate_id, aggregate_version, operation, projected_at, payload_digest, commit_cursor, change_index';
export const CATALOG_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export const CATALOG_METADATA_MAX_ENTRIES = 4096;
interface Entry { readonly header: string; readonly row: PublicProjectionCatalogRow | null; readonly bytes: number }

/** Bounded, disposable metadata only. Every hit remains bound to the immutable durable header. */
export class SqliteProjectionCatalogMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly storageVersion: number;

  constructor(private readonly database: DatabaseSync,
    private readonly changeFromRow: (row: SnapshotVersionRow) => StoredProjectionChange) {
    this.storageVersion = this.readStorageVersion();
  }

  assertStorageUnchanged(): void {
    // SQLite's connection-local data_version changes on another connection's
    // durable write, not on our own commits. The exclusive owner admits no
    // external writer, so never serve cached metadata after such a change.
    if (this.readStorageVersion() !== this.storageVersion) {
      throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:catalog:external_write:row_mismatch'));
    }
  }

  rememberVerified(change: StoredProjectionChange, header: CatalogVersionHeader): void {
    if (!['sessions', 'runs', 'decisions'].includes(change.feature)) return;
    const row = change.operation === 'delete' ? null : storedProjectionCatalogRow(change);
    // Serialize only the stripped public row. No object retaining an Inbox,
    // question, action token, Tool body or interaction history enters this cache.
    const json = canonicalPublicProjectionJson(row), headerJson = binding(header), key = identity(header);
    const bytes = Buffer.byteLength(json) + Buffer.byteLength(headerJson) + Buffer.byteLength(key);
    const old = this.entries.get(key);
    if (old !== undefined) {
      if (old.header !== headerJson) throw corrupt(header);
      this.entries.delete(key); this.bytes -= old.bytes;
    }
    if (bytes > CATALOG_METADATA_MAX_BYTES) return;
    while (this.entries.size >= CATALOG_METADATA_MAX_ENTRIES || this.bytes + bytes > CATALOG_METADATA_MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest); this.evictions++;
    }
    this.entries.set(key, { header: headerJson, row: JSON.parse(json) as PublicProjectionCatalogRow | null, bytes });
    this.bytes += bytes;
  }

  read(header: CatalogVersionHeader): PublicProjectionCatalogRow | null {
    const key = identity(header), cached = this.entries.get(key);
    if (cached !== undefined) {
      if (cached.header !== binding(header)) throw corrupt(header);
      this.entries.delete(key); this.entries.set(key, cached); this.hits++;
      return cached.row;
    }
    this.misses++;
    const source = this.database.prepare(`SELECT * FROM projection_versions
      WHERE feature=? AND aggregate_id=? AND aggregate_version=?`).get(header.feature,
        header.aggregate_id, header.aggregate_version) as unknown as SnapshotVersionRow | undefined;
    if (source === undefined || binding(source) !== binding(header)) throw corrupt(header);
    const change = this.changeFromRow(source);
    this.rememberVerified(change, source);
    return this.entries.get(key)?.row ?? (change.operation === 'delete' ? null : storedProjectionCatalogRow(change));
  }

  sessionOwnsWorkspace(sessionId: string, workspaceId: string, boundary: number): boolean {
    const header = this.database.prepare(`SELECT ${CATALOG_VERSION_HEADER_COLUMNS} FROM projection_versions
      WHERE feature='sessions' AND aggregate_id=? AND commit_cursor<=?
      ORDER BY aggregate_version DESC LIMIT 1`).get(sessionId, boundary) as unknown as CatalogVersionHeader | undefined;
    if (header === undefined) return false;
    const row = this.read(header);
    return row?.feature === 'sessions' && row.dto.workspaceId === workspaceId;
  }

  stats() { return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses,
    evictions: this.evictions, maxEntries: CATALOG_METADATA_MAX_ENTRIES, maxBytes: CATALOG_METADATA_MAX_BYTES }; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  private readStorageVersion(): number {
    return Number(this.database.prepare('PRAGMA data_version').get()!.data_version);
  }
}

function identity(header: CatalogVersionHeader): string {
  return `${header.feature}\u0000${header.aggregate_id}\u0000${String(header.aggregate_version)}`;
}
function binding(header: CatalogVersionHeader): string {
  return JSON.stringify([header.feature, header.aggregate_id, header.aggregate_version, header.operation,
    header.projected_at, header.payload_digest, header.commit_cursor, header.change_index]);
}
function corrupt(header: CatalogVersionHeader): Error {
  return markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:version:${header.feature}:${header.aggregate_id}:${header.aggregate_version}:row_mismatch`));
}
