import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { PublicProjectionCatalogManifest } from '@ariadne/protocol/public';
import type { SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';
export interface MessageMetadataSourceRow extends Omit<SnapshotVersionRow, 'dto_json'> {
  kind: 'message' | 'run_document'; message_id: string; item_ordinal: number | null; metadata_json: string;
}
export type MessageMetadataOrderKey = readonly [string, number, string];
const time = "json_extract(m.metadata_json,'$.createdAt')";
const role = "CASE json_extract(m.metadata_json,'$.role') WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END";
const order = `${time},${role},m.message_id`;
const columns = 'v.feature,v.aggregate_id,v.aggregate_version,v.operation,v.projected_at,v.payload_digest,v.commit_cursor,v.change_index';
const latest = `v.operation='upsert' AND v.commit_cursor<=? AND NOT EXISTS (SELECT 1 FROM projection_versions newer
  WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?)`;
const standaloneOwns = (id: string) => `NOT EXISTS (SELECT 1 FROM projection_versions message
  WHERE message.feature='messages' AND message.aggregate_id=${id} AND message.commit_cursor<=?)`;

/** SQL strips bodies before sorting and returning candidates. It never selects
 * a document BLOB; only the selected immutable parent may later be validated. */
export class SqliteMessageMetadataSources {
  private readonly sql: string;
  private readonly parameters: SQLInputValue[];
  constructor(private readonly database: DatabaseSync, manifest: PublicProjectionCatalogManifest) {
    if (manifest.scope.kind !== 'session') throw new Error('message_metadata_session_required');
    const { sessionId } = manifest.scope, c = manifest.boundaryCursor;
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 3 && version !== 4) throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:message_metadata:schema_unsupported'));
    const legacyMetadata = `CASE WHEN json_type(interaction.value,'$.runId') IS NULL
      THEN json_set(json_remove(interaction.value,'$.content'),'$.runId',v.aggregate_id)
      ELSE json_remove(interaction.value,'$.content') END`;
    const branches = [`SELECT 'message' AS kind,${columns},v.aggregate_id AS message_id,NULL AS item_ordinal,
      json_remove(v.dto_json,'$.content') AS metadata_json FROM projection_versions v
      WHERE v.feature='messages' AND json_extract(v.dto_json,'$.sessionId')=? AND ${latest}`,
      `SELECT 'run_document' AS kind,${columns},json_extract(interaction.value,'$.messageId') AS message_id,
      CAST(interaction.key AS INTEGER) AS item_ordinal,${legacyMetadata} AS metadata_json
      FROM projection_versions v,json_each(v.dto_json,'$.interactionMessages') interaction
      WHERE v.feature='runs' AND json_type(v.dto_json,'$.documentContractVersion') IS NULL
        AND json_extract(v.dto_json,'$.sessionId')=? AND ${latest} AND ${standaloneOwns("json_extract(interaction.value,'$.messageId')")}`];
    this.parameters = [sessionId, c, c, sessionId, c, c, c];
    if (version === 4) {
      // Declared interactions cannot disappear because an item index or
      // publication link is missing, even for an empty/negative window.
      const missing = database.prepare(`SELECT 1 FROM projection_versions v LEFT JOIN projection_run_documents d
        ON d.run_id=v.aggregate_id AND d.run_version=v.aggregate_version
        WHERE v.feature='runs' AND json_extract(v.dto_json,'$.documentContractVersion')='1.0'
          AND json_extract(v.dto_json,'$.summary.sessionId')=? AND ${latest}
          AND (d.preparation_state IS NULL OR d.preparation_state!='prepared' OR d.published_cursor IS NULL OR d.published_cursor!=v.commit_cursor
            OR d.document_digest!=json_extract(v.dto_json,'$.documentDigest') OR d.header_json!=v.dto_json
            OR (SELECT COUNT(*) FROM projection_run_document_items i WHERE i.run_id=v.aggregate_id
              AND i.run_version=v.aggregate_version AND i.collection='interactionMessages')!=json_extract(v.dto_json,'$.collections.interactionMessages.itemCount')) LIMIT 1`)
        .get(sessionId, c, c);
      if (missing !== undefined) throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:message_metadata:document_coverage_missing'));
      branches.push(`SELECT 'run_document' AS kind,${columns},i.item_id AS message_id,i.item_ordinal,
        json_extract(i.metadata_json,'$.value') AS metadata_json
        FROM projection_versions v JOIN projection_run_documents d ON d.run_id=v.aggregate_id AND d.run_version=v.aggregate_version
          AND d.preparation_state='prepared' AND d.published_cursor=v.commit_cursor
        JOIN projection_run_document_items i ON i.run_id=v.aggregate_id AND i.run_version=v.aggregate_version AND i.collection='interactionMessages'
        WHERE v.feature='runs' AND json_extract(v.dto_json,'$.documentContractVersion')='1.0'
          AND json_extract(v.dto_json,'$.summary.sessionId')=? AND ${latest} AND ${standaloneOwns('i.item_id')}`);
      this.parameters.push(sessionId, c, c, c);
    }
    this.sql = branches.join(' UNION ALL ');
    const duplicate = database.prepare(`SELECT m.message_id FROM (${this.sql}) m GROUP BY m.message_id HAVING COUNT(*)>1 LIMIT 1`).get(...this.parameters);
    if (duplicate !== undefined) throw markAuthorityIntegrityError('projection', new Error('public_projection_storage_corruption:message_metadata:duplicate_identity'));
  }
  anchor(id: string): MessageMetadataSourceRow | undefined {
    return this.database.prepare(`SELECT m.* FROM (${this.sql}) m WHERE m.message_id=? LIMIT 1`).get(...this.parameters, id) as unknown as MessageMetadataSourceRow | undefined;
  }
  rows(direction: 'older' | 'newer', limit: number, anchor?: MessageMetadataOrderKey): IterableIterator<MessageMetadataSourceRow> {
    const comparison = anchor === undefined ? '' : `AND (${order}) ${direction === 'older' ? '<' : '>'} (?,?,?)`;
    const sorting = direction === 'older' ? `${time} DESC,${role} DESC,m.message_id DESC` : order;
    return this.database.prepare(`SELECT m.* FROM (${this.sql}) m WHERE 1=1 ${comparison} ORDER BY ${sorting} LIMIT ?`)
      .iterate(...this.parameters, ...(anchor ?? []), limit) as unknown as IterableIterator<MessageMetadataSourceRow>;
  }
  exists(direction: 'older' | 'newer', anchor: MessageMetadataOrderKey): boolean {
    return this.database.prepare(`SELECT 1 FROM (${this.sql}) m WHERE (${order}) ${direction === 'older' ? '<' : '>'} (?,?,?) LIMIT 1`)
      .get(...this.parameters, ...anchor) !== undefined;
  }
}
