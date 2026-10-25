import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MAX_PUBLIC_PROJECTION_PAGE_BYTES, assertPublicProjectionMessageWindow,
  canonicalPublicProjectionJson,
  type PublicProjectionChange, type PublicProjectionViewManifest,
  type PublicProjectionMessageWindow, type PublicProjectionMessageWindowResult, type PublicRunProjection
} from '@ariadne/protocol/public';
import type { SnapshotVersionRow } from './SqliteProjectionSnapshotReader.js';

type MessageChange = Extract<PublicProjectionChange, { feature: 'messages' }> & { dto: NonNullable<
  Extract<PublicProjectionChange, { feature: 'messages' }>['dto']> };
type OrderKey = readonly [string, number, string];
interface WindowSourceRow extends SnapshotVersionRow { readonly message_json: string; readonly message_id: string }
const timeSql = "json_extract(m.message_json, '$.createdAt')";
const roleSql = "CASE json_extract(m.message_json, '$.role') WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END";
const orderSql = `${timeSql}, ${roleSql}, m.message_id`;
const latest = `v.operation='upsert' AND json_extract(v.dto_json, '$.sessionId')=? AND v.commit_cursor<=?
  AND NOT EXISTS (SELECT 1 FROM projection_versions newer
    WHERE newer.feature=v.feature AND newer.aggregate_id=v.aggregate_id
      AND newer.aggregate_version>v.aggregate_version AND newer.commit_cursor<=?)`;
// Agent interaction messages have always belonged to immutable Run versions.
// Flatten only a bounded query window; do not materialize a second message store.
const sourcesSql = `SELECT v.*, v.dto_json AS message_json, v.aggregate_id AS message_id
    FROM projection_versions v WHERE v.feature='messages' AND ${latest}
  UNION ALL SELECT v.*, interaction.value AS message_json, json_extract(interaction.value,'$.messageId') AS message_id
    FROM projection_versions v, json_each(v.dto_json,'$.interactionMessages') interaction
    WHERE v.feature='runs' AND ${latest} AND NOT EXISTS (SELECT 1 FROM projection_versions message
      WHERE message.feature='messages' AND message.aggregate_id=json_extract(interaction.value,'$.messageId') AND message.commit_cursor<=?)`;

/** Bounded bodies at the same C as the selected metadata pages. No stored UI state. */
export function readProjectionMessageWindow(database: DatabaseSync, manifest: PublicProjectionViewManifest,
  window: PublicProjectionMessageWindow,
  changeFromRow: (row: SnapshotVersionRow) => PublicProjectionChange): PublicProjectionMessageWindowResult {
  if (manifest.scope.kind !== 'session') throw new Error('public_projection_message_window_scope_invalid');
  const sessionId = manifest.scope.sessionId;
  const parameters: SQLInputValue[] = [sessionId, manifest.boundaryCursor, manifest.boundaryCursor,
    sessionId, manifest.boundaryCursor, manifest.boundaryCursor, manifest.boundaryCursor];
  // At most four validated parent bodies, never all selected Run history.
  const parents = new Map<string, PublicRunProjection>();
  const readChange = (row: WindowSourceRow): MessageChange => {
    let change: PublicProjectionChange;
    if (row.feature === 'runs') {
      const identity = `${row.aggregate_id}\u0000${row.aggregate_version}`;
      let parent = parents.get(identity);
      if (parent === undefined) {
        const source = changeFromRow(row);
        if (source.feature !== 'runs' || source.dto === null || source.operation !== 'upsert') throw new Error('public_projection_message_window_owner_drift');
        parent = source.dto;
        while (parents.size >= 4) parents.delete(parents.keys().next().value!);
        parents.set(identity, parent);
      }
      const message = parent.interactionMessages.find(item => item.messageId === row.message_id);
      if (message === undefined || parent.sessionId !== sessionId || message.sessionId !== sessionId || message.runId !== parent.runId
        || canonicalPublicProjectionJson(message) !== canonicalPublicProjectionJson(JSON.parse(row.message_json))) {
        throw new Error('public_projection_message_window_interaction_owner_drift');
      }
      change = { feature: 'messages', operation: 'upsert', aggregateId: message.messageId, aggregateVersion: message.version,
        projectedAt: row.projected_at, dto: message };
    } else change = changeFromRow(row);
    if (change.feature !== 'messages' || change.dto === null || change.operation !== 'upsert'
      || change.dto.sessionId !== sessionId || change.aggregateId !== row.message_id) throw new Error('public_projection_message_window_owner_drift');
    return change as MessageChange;
  };
  const rows = (direction: 'older' | 'newer', anchor?: OrderKey): IterableIterator<WindowSourceRow> => {
    const comparison = anchor === undefined ? '' : `AND (${orderSql}) ${direction === 'older' ? '<' : '>'} (?, ?, ?)`;
    const order = direction === 'older' ? `${timeSql} DESC, ${roleSql} DESC, m.message_id DESC` : orderSql;
    return database.prepare(`SELECT m.* FROM (${sourcesSql}) m WHERE 1=1 ${comparison}
      ORDER BY ${order} LIMIT ?`).iterate(...parameters, ...(anchor ?? []), window.limit + 1) as unknown as IterableIterator<WindowSourceRow>;
  };
  let anchor: MessageChange | undefined;
  if (window.kind !== 'latest') {
    const row = database.prepare(`SELECT m.* FROM (${sourcesSql}) m WHERE m.message_id=? LIMIT 1`)
      .get(...parameters, window.anchorMessageId) as unknown as WindowSourceRow | undefined;
    if (row === undefined) return { status: 'anchor_unavailable', snapshotId: manifest.snapshotId };
    anchor = readChange(row);
  }
  const changes: MessageChange[] = [];
  let bytes = 0;
  const envelopeBytes = Buffer.byteLength(canonicalPublicProjectionJson({ status: 'ok', manifest, window,
    changes: [], hasEarlier: false, hasLater: false, windowDigest: `sha256:${'0'.repeat(64)}` }));
  const admit = (change: MessageChange): boolean => {
    const size = Buffer.byteLength(canonicalPublicProjectionJson(change));
    if (envelopeBytes + bytes + size + changes.length > MAX_PUBLIC_PROJECTION_PAGE_BYTES) return false;
    changes.push(change);
    bytes += size;
    return true;
  };
  const older = rows('older', anchor === undefined ? undefined : key(anchor));
  let newer: IterableIterator<WindowSourceRow> | undefined;
  try {
    if (window.kind === 'around' && anchor !== undefined) {
      if (!admit(anchor)) throw new Error('public_projection_message_window_anchor_exceeds_capacity');
      newer = rows('newer', key(anchor));
      let olderDone = false;
      let newerDone = false;
      let turn = 0;
      while (changes.length < window.limit && !(olderDone && newerDone)) {
        const takeOlder = !olderDone && (newerDone || turn++ % 2 === 0);
        const candidate = takeOlder ? older.next() : newer.next();
        if (candidate.done) {
          if (takeOlder) olderDone = true;
          else newerDone = true;
          continue;
        }
        if (!admit(readChange(candidate.value))) break;
      }
    } else {
      for (const row of older) {
        if (changes.length >= window.limit || !admit(readChange(row))) break;
      }
    }
  } finally {
    // Statement iterators must release even when byte/row limits stop early.
    older.return?.();
    newer?.return?.();
  }
  changes.sort(compare);
  const first = changes[0];
  const last = changes.at(-1);
  const exists = (direction: 'older' | 'newer', boundary: OrderKey): boolean => database.prepare(
    `SELECT 1 FROM (${sourcesSql}) m WHERE (${orderSql}) ${direction === 'older' ? '<' : '>'} (?, ?, ?) LIMIT 1`
  ).get(...parameters, ...boundary) !== undefined;
  const hasEarlier = first === undefined ? false : exists('older', key(first));
  const hasLater = last === undefined ? anchor !== undefined : exists('newer', key(last));
  const payload = { status: 'ok' as const, manifest, window, changes, hasEarlier, hasLater };
  const windowDigest = `sha256:${createHash('sha256').update(canonicalPublicProjectionJson(payload)).digest('hex')}`;
  return assertPublicProjectionMessageWindow({ ...payload, windowDigest });
}
function key(change: MessageChange): OrderKey {
  return [change.dto.createdAt, change.dto.role === 'user' ? 0 : change.dto.role === 'assistant' ? 1 : 2, change.aggregateId];
}
function compare(left: MessageChange, right: MessageChange): number {
  const a = key(left), b = key(right);
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]
    || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
