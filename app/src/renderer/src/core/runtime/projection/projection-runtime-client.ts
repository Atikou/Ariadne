import { PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION, publicProjectionSnapshotManifestSchema, canonicalPublicProjectionJson,
  assertPublicProjectionSnapshotPage, verifyPublicProjectionScopedReadBatch,
  type PublicProjectionScope, type PublicProjectionSnapshotManifest,
  type PublicProjectionSnapshotPageResult, type PublicProjectionScopedReadRequest,
  type PublicProjectionScopedReadBatch } from '@ariadne/protocol/public';
import { PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, publicProjectionViewManifestSchema,
  assertPublicProjectionViewPage, verifyPublicProjectionMessageWindow,
  type PublicProjectionViewManifest, type PublicProjectionFeature,
  type PublicProjectionViewPageResult, type PublicProjectionMessageWindow,
  type PublicProjectionMessageWindowResult } from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import { PUBLIC_PROJECTION_CATALOG_VERSION, publicProjectionCatalogManifestSchema,
  publicProjectionCatalogPageResultSchema, publicProjectionCatalogDetailResultSchema,
  assertProjectionCatalogResult, catalogSha256, verifyCatalogBatch,
  type PublicProjectionCatalogBeginRequest, type PublicProjectionCatalogManifest,
  type PublicProjectionCatalogPageResult, type PublicProjectionCatalogDetailResult,
  type PublicProjectionCatalogReadRequest, type PublicProjectionCatalogBatchResult,
  type PublicProjectionCatalogReset } from '@ariadne/protocol/public';
import { unwrapPublicResult } from '../public-result';
import { verifyPublicProjectionFeatureWindow, type PublicProjectionFeatureWindow,
  type PublicProjectionFeatureWindowResult } from '@ariadne/protocol/public';
import { verifyPublicProjectionFeatureReceipts, verifyRunDocumentRootResult, verifyRunDocumentMetadataResult,
  verifyRunDocumentInboxResult, verifyRunDocumentChunkResult, verifyMessageMetadataWindow, verifyMessageBody,
  type PublicProjectionFeatureReceiptRequest, type PublicRunDocumentRootRequest, type PublicRunDocumentMetadataRequest,
  type PublicRunDocumentInboxRequest, type PublicRunDocumentChunkRequest, type PublicMessageMetadataWindowRequest,
  type PublicMessageBodyRequest } from '@ariadne/protocol/public';
import { verifyConversationReceipts, verifyConversationInferenceWindow,
  type PublicConversationReceiptRequest, type PublicConversationInferenceRequest } from '@ariadne/protocol/public';

export class ProjectionProtocolIntegrityError extends Error {
  constructor(readonly integrityCode: string) {
    super(`projection_protocol_integrity_error:${integrityCode}`);
    this.name = 'ProjectionProtocolIntegrityError';
  }
}

export class ProjectionScopedReadResetSignal extends Error {
  constructor(readonly reason: Extract<PublicProjectionScopedReadBatch, { status: 'reset_required' }>['reason']) {
    super(`projection_scoped_read_reset_required:${reason}`);
    this.name = 'ProjectionScopedReadResetSignal';
  }
}

export class ProjectionCatalogResetSignal extends Error {
  constructor(readonly reason: PublicProjectionCatalogReset['reason']) {
    super(`projection_catalog_reset_required:${reason}`);
    this.name = 'ProjectionCatalogResetSignal';
  }
}

export class ProjectionRuntimeClient {
  constructor(private readonly api: AriadneApi['runtime']) {}

  async readConversationReceipts(request: PublicConversationReceiptRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.conversation.receipts', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.conversation.receipts_result') throw new Error('conversation_receipt_result_invalid');
    try { return await verifyConversationReceipts(request, result.batch); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }
  async readConversationInferenceWindow(request: PublicConversationInferenceRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.conversation.inference_window', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.conversation.inference_window_result') throw new Error('conversation_inference_result_invalid');
    try { return await verifyConversationInferenceWindow(request, result.window); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readFeatureReceipts(request: PublicProjectionFeatureReceiptRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.features.receipts', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.features.receipts_result') throw new Error('projection_feature_receipt_result_invalid');
    try { return await verifyPublicProjectionFeatureReceipts(request, result.batch); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readRunDocument(request: PublicRunDocumentRootRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.run_document.root', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.run_document.root_result') throw new Error('projection_run_document_result_invalid');
    try { return await verifyRunDocumentRootResult(request, result.document); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readRunDocumentMetadata(request: PublicRunDocumentMetadataRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.run_document.metadata', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.run_document.metadata_result') throw new Error('projection_run_document_metadata_result_invalid');
    try { return await verifyRunDocumentMetadataResult(request, result.page); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readRunDocumentInbox(request: PublicRunDocumentInboxRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.run_document.inbox', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.run_document.inbox_result') throw new Error('projection_run_document_inbox_result_invalid');
    try { return await verifyRunDocumentInboxResult(request, result.input); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readRunDocumentChunk(request: PublicRunDocumentChunkRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.run_document.chunk', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.run_document.chunk_result') throw new Error('projection_run_document_chunk_result_invalid');
    try { return await verifyRunDocumentChunkResult(request, result.chunk); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readMessageMetadataWindow(request: PublicMessageMetadataWindowRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.messages.metadata', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.messages.metadata_result') throw new Error('projection_message_metadata_result_invalid');
    try { return await verifyMessageMetadataWindow(request, result.window); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readMessageBody(request: PublicMessageBodyRequest) {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.messages.body', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.messages.body_result') throw new Error('projection_message_body_result_invalid');
    try { return await verifyMessageBody(request, result.body); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readFeatureWindow(manifest: PublicProjectionViewManifest, window: PublicProjectionFeatureWindow): Promise<PublicProjectionFeatureWindowResult> {
    const request = { windowContractVersion: '1.0' as const, manifest, window };
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.features.window', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.features.window_result') throw new Error('projection_feature_window_result_invalid');
    try { return await verifyPublicProjectionFeatureWindow(request, result.window); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async beginCatalog(request: Omit<PublicProjectionCatalogBeginRequest, 'pageContractVersion'>): Promise<PublicProjectionCatalogManifest> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.catalog.begin',
      request: { pageContractVersion: PUBLIC_PROJECTION_CATALOG_VERSION, ...request } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.catalog.manifest') throw new Error('projection_catalog_manifest_result_invalid');
    if ('status' in result.manifest) throw new ProjectionCatalogResetSignal(result.manifest.reason);
    try {
      const manifest = publicProjectionCatalogManifestSchema.parse(result.manifest);
      if (canonicalPublicProjectionJson(manifest.scope) !== canonicalPublicProjectionJson(request.scope)
        || manifest.feature !== request.feature || manifest.filter !== request.filter) throw new Error('projection_catalog_selection_mismatch');
      return manifest;
    } catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readCatalogPage(manifest: PublicProjectionCatalogManifest, pageCursor?: string, limit = 128): Promise<PublicProjectionCatalogPageResult> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.catalog.page',
      request: { manifest, limit, ...(pageCursor === undefined ? {} : { pageCursor }) } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.catalog.page_result') throw new Error('projection_catalog_page_result_invalid');
    try {
      const page = assertProjectionCatalogResult(publicProjectionCatalogPageResultSchema, result.page);
      if (page.status !== 'ok') return page;
      if (canonicalPublicProjectionJson(page.manifest) !== canonicalPublicProjectionJson(manifest) || page.rows.length > limit
        || (pageCursor === undefined ? page.pageIndex !== 0 : page.pageIndex < 1)) throw new Error('projection_catalog_page_request_mismatch');
      const { pageDigest, nextPageCursor: _cursor, ...payload } = page;
      if (pageDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_catalog_page_digest_mismatch');
      return page;
    } catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readCatalogDetail(manifest: PublicProjectionCatalogManifest, aggregateId: string): Promise<PublicProjectionCatalogDetailResult> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.catalog.detail', request: { manifest, aggregateId } },
      { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.catalog.detail_result') throw new Error('projection_catalog_detail_result_invalid');
    try {
      const detail = assertProjectionCatalogResult(publicProjectionCatalogDetailResultSchema, result.detail);
      if (detail.status !== 'ok') return detail;
      if (canonicalPublicProjectionJson(detail.manifest) !== canonicalPublicProjectionJson(manifest) || detail.aggregateId !== aggregateId) {
        throw new Error('projection_catalog_detail_request_mismatch');
      }
      const { detailDigest, ...payload } = detail;
      if (detailDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_catalog_detail_digest_mismatch');
      return detail;
    } catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readCatalogCommits(request: PublicProjectionCatalogReadRequest): Promise<PublicProjectionCatalogBatchResult> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.catalog.read', request }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.catalog.batch') throw new Error('projection_catalog_batch_result_invalid');
    try { return await verifyCatalogBatch(request, result.batch); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async beginViewSnapshot(scope: PublicProjectionScope,
    features: readonly PublicProjectionFeature[]): Promise<PublicProjectionViewManifest> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.view.begin', request: {
      pageContractVersion: PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION, scope, features: [...features]
    } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.view.manifest') throw new Error('projection_view_manifest_result_invalid');
    if ('status' in result.manifest) throw new ProjectionSnapshotResetSignal(result.manifest.reason);
    try {
      const manifest = publicProjectionViewManifestSchema.parse(result.manifest);
      if (canonicalPublicProjectionJson(manifest.scope) !== canonicalPublicProjectionJson(scope)
        || canonicalPublicProjectionJson(manifest.selectedFeatures) !== canonicalPublicProjectionJson(features)) {
        throw new Error('projection_view_selection_mismatch');
      }
      return manifest;
    } catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readViewPage(manifest: PublicProjectionViewManifest,
    pageCursor?: string): Promise<PublicProjectionViewPageResult> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.view.page', request: {
      pageContractVersion: manifest.pageContractVersion, snapshotId: manifest.snapshotId, streamId: manifest.streamId,
      boundaryCursor: manifest.boundaryCursor, boundaryDigest: manifest.boundaryDigest, scope: manifest.scope,
      selectedFeatures: manifest.selectedFeatures, limit: 128,
      ...(pageCursor === undefined ? {} : { pageCursor })
    } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.view.page_result') throw new Error('projection_view_page_result_invalid');
    try { return assertPublicProjectionViewPage(result.page); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readMessageWindow(manifest: PublicProjectionViewManifest,
    window: PublicProjectionMessageWindow): Promise<PublicProjectionMessageWindowResult> {
    const request = { manifest, window };
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.messages.window', request },
      { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.messages.window_result') throw new Error('projection_message_window_result_invalid');
    try { return await verifyPublicProjectionMessageWindow(request, result.window); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async beginScopeSnapshot(scope: PublicProjectionScope): Promise<PublicProjectionSnapshotManifest> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.snapshot.begin', request: {
      pageContractVersion: PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION, scope
    } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.snapshot.manifest') throw new Error('projection_snapshot_manifest_result_invalid');
    if ('status' in result.manifest) throw new ProjectionSnapshotResetSignal(result.manifest.reason);
    try {
      const manifest = publicProjectionSnapshotManifestSchema.parse(result.manifest);
      if (canonicalPublicProjectionJson(manifest.scope) !== canonicalPublicProjectionJson(scope)) {
        throw new Error('projection_snapshot_scope_mismatch');
      }
      return manifest;
    } catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readScopePage(manifest: PublicProjectionSnapshotManifest,
    pageCursor?: string): Promise<PublicProjectionSnapshotPageResult> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.snapshot.page', request: {
      pageContractVersion: manifest.pageContractVersion, snapshotId: manifest.snapshotId,
      streamId: manifest.streamId, boundaryCursor: manifest.boundaryCursor,
      boundaryDigest: manifest.boundaryDigest, scope: manifest.scope, limit: 128,
      ...(pageCursor === undefined ? {} : { pageCursor })
    } }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.snapshot.page_result') throw new Error('projection_snapshot_page_result_invalid');
    try { return assertPublicProjectionSnapshotPage(result.page); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

  async readScopedCommits(request: PublicProjectionScopedReadRequest): Promise<PublicProjectionScopedReadBatch> {
    const result = unwrapPublicResult(await this.api.request({ kind: 'projection.scope.read', request },
      { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.scope.batch') throw new Error('projection_scoped_read_result_invalid');
    try { return await verifyPublicProjectionScopedReadBatch(request, result.batch); }
    catch (error) { throw new ProjectionProtocolIntegrityError(errorCode(error)); }
  }

}

export class ProjectionSnapshotResetSignal extends Error {
  constructor(readonly reason: Extract<PublicProjectionSnapshotPageResult, { status: 'reset_required' }>['reason']) {
    super(`projection_snapshot_reset_required:${reason}`);
    this.name = 'ProjectionSnapshotResetSignal';
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 512) || 'unknown';
}
