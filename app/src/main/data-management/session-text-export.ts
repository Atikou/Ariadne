import { canonicalPublicProjectionJson, comparePublicProjectionMessages, messageMetadataOf,
  publicProjectionCatalogManifestSchema, verifyMessageMetadataWindow, verifyMessageBody,
  verifyRunDocumentChunkResult, runDocumentItemMetadata, RunDocumentItemAssembler,
  type PublicMessageMetadataRow, type PublicProjectionCatalogManifest, type PublicMessageProjection,
  type PublicProjectionMessageWindow, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { sessionTextExportRequestSchema, sessionTextExportResultSchema,
  type SessionTextExportRequest, type SessionTextExportResult } from '@shared/data-management';

/** Streaming, explicit text-only export of one authorized public Session at one
 * immutable C. Uses original public owner/proof readers, never raw databases,
 * credentials, tool-detail grants, inference reasoning or private Core payloads.
 * Newest-first JSONL avoids holding/reversing all history in Main memory. */
export async function writeSessionTextExport(input: SessionTextExportRequest,
  request: (command: RuntimeCommand) => Promise<RuntimeResult>, write: (line: string) => Promise<void>): Promise<SessionTextExportResult> {
  input = sessionTextExportRequestSchema.parse(input);
  const scope = { kind: 'session' as const, workspaceId: input.workspaceId, sessionId: input.sessionId };
  const opened = await request({ kind: 'projection.catalog.begin', request: { pageContractVersion: '3.0', scope, feature: 'runs', filter: 'all' } });
  if (opened.kind !== 'projection.catalog.manifest' || 'status' in opened.manifest) throw new Error('session_export_snapshot_unavailable');
  const manifest = publicProjectionCatalogManifestSchema.parse(opened.manifest);
  if (canonicalPublicProjectionJson(manifest.scope) !== canonicalPublicProjectionJson(scope)
    || manifest.feature !== 'runs' || manifest.filter !== 'all') throw new Error('session_export_scope_mismatch');
  let bytes = 0, messages = 0, attachmentReferences = 0;
  const emit = async (record: unknown): Promise<void> => {
    const line = JSON.stringify(record) + '\n'; bytes += Buffer.byteLength(line);
    if (bytes > 512 * 1024 * 1024) throw new Error('session_export_capacity_exceeded');
    await write(line);
  };
  await emit({ format: 'ariadne.session-public-text', version: 1, order: 'newest-first', scope,
    boundary: { streamId: manifest.streamId, cursor: manifest.boundaryCursor, digest: manifest.boundaryDigest },
    capturedAt: manifest.capturedAt, includes: ['public-message-text', 'attachment-references'],
    excludes: ['attachment-bytes', 'tool-details', 'inference-reasoning', 'private-execution-payloads', 'system-credentials'] });
  let window: PublicProjectionMessageWindow = { kind: 'latest', limit: 128 };
  let previous: ReturnType<typeof messageMetadataOf> | undefined;
  for (;;) {
    const query = { queryContractVersion: '1.0', manifest, window };
    const response = await request({ kind: 'projection.messages.metadata', request: query });
    if (response.kind !== 'projection.messages.metadata_result') throw new Error('session_export_metadata_unavailable');
    const page = await verifyMessageMetadataWindow(query, response.window);
    if (page.status !== 'ok' || (page.hasEarlier && page.rows.length === 0)) throw new Error('session_export_snapshot_unavailable');
    for (let index = page.rows.length - 1; index >= 0; index--) {
      const row = page.rows[index]!, metadata = messageMetadataOf(row);
      if (previous && comparePublicProjectionMessages(metadata, previous) >= 0) throw new Error('session_export_order_mismatch');
      if (++messages > 100_000) throw new Error('session_export_capacity_exceeded');
      const message = await readTextMessage(manifest, row, request);
      attachmentReferences += message.attachments?.length ?? 0;
      await emit({ messageId: message.messageId, version: message.version, role: message.role, content: message.content,
        status: message.status, createdAt: message.createdAt, updatedAt: message.updatedAt,
        ...(message.attachments ? { attachmentReferences: message.attachments } : {}) });
      previous = metadata;
    }
    if (!page.hasEarlier) break;
    window = { kind: 'before', anchorMessageId: messageMetadataOf(page.rows[0]!).messageId, limit: 128 };
  }
  await emit({ complete: true, messages, attachmentReferences });
  return sessionTextExportResultSchema.parse({ messages, bytes, attachmentReferences });
}
async function readTextMessage(manifest: PublicProjectionCatalogManifest, row: PublicMessageMetadataRow,
  request: (command: RuntimeCommand) => Promise<RuntimeResult>): Promise<PublicMessageProjection> {
  if (row.kind === 'message') {
    const query = { queryContractVersion: '1.0', manifest, body: row.body };
    const response = await request({ kind: 'projection.messages.body', request: query });
    if (response.kind !== 'projection.messages.body_result') throw new Error('session_export_body_unavailable');
    const body = await verifyMessageBody(query, response.body);
    if (body.status !== 'ok') throw new Error('session_export_body_unavailable'); return body.message;
  }
  const descriptor = row.proof.descriptor;
  if (descriptor.collection !== 'interactionMessages') throw new Error('session_export_body_scope_invalid');
  const assembler = new RunDocumentItemAssembler(row.header, descriptor.collection, descriptor.itemOrdinal);
  let item: Awaited<ReturnType<RunDocumentItemAssembler['accept']>> = null;
  for (let chunkOrdinal = 0; chunkOrdinal < descriptor.chunkCount; chunkOrdinal++) {
    const query = { queryContractVersion: '1.0', manifest, document: row.document, collection: descriptor.collection,
      itemOrdinal: descriptor.itemOrdinal, chunkOrdinal };
    const response = await request({ kind: 'projection.run_document.chunk', request: query });
    if (response.kind !== 'projection.run_document.chunk_result') throw new Error('session_export_chunk_unavailable');
    const chunk = await verifyRunDocumentChunkResult(query, response.chunk);
    if (chunk.status !== 'ok') throw new Error('session_export_chunk_unavailable'); item = await assembler.accept(chunk.leaf);
  }
  if (!item || item.collection !== 'interactionMessages'
    || canonicalPublicProjectionJson(runDocumentItemMetadata(item)) !== canonicalPublicProjectionJson(row.proof.metadata))
    throw new Error('session_export_message_metadata_mismatch');
  return item.value;
}
