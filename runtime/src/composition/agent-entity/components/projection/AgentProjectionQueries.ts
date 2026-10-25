import { PUBLIC_PROJECTION_CONTRACT_VERSION, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import type { AgentPersistenceComponentHandle } from '../persistence/AgentPersistenceComponent.js';

/** Query routing for the one Projection owner; this helper owns no state or writes. */
export function readAgentProjectionQuery(
  store: AgentPersistenceComponentHandle['publicProjection'], command: RuntimeCommand
): Promise<RuntimeResult> {
  switch (command.kind) {
    case 'projection.conversation.receipts':
      return store.readConversationReceipts(command.request).then(batch => ({ kind: 'projection.conversation.receipts_result', batch }));
    case 'projection.conversation.inference_window':
      return store.readConversationInferenceWindow(command.request).then(window => ({ kind: 'projection.conversation.inference_window_result', window }));
    case 'projection.features.receipts':
      return store.readFeatureReceipts(command.request).then(batch => ({ kind: 'projection.features.receipts_result', batch }));
    case 'projection.run_document.root':
      return store.readRunDocument(command.request).then(document => ({ kind: 'projection.run_document.root_result', document }));
    case 'projection.run_document.metadata':
      return store.readRunDocumentMetadataPage(command.request).then(page => ({ kind: 'projection.run_document.metadata_result', page }));
    case 'projection.run_document.inbox':
      return store.readRunDocumentInboxInput(command.request).then(input => ({ kind: 'projection.run_document.inbox_result', input }));
    case 'projection.run_document.chunk':
      return store.readRunDocumentChunk(command.request).then(chunk => ({ kind: 'projection.run_document.chunk_result', chunk }));
    case 'projection.messages.metadata':
      return store.readMessageMetadataWindow(command.request).then(window => ({ kind: 'projection.messages.metadata_result', window }));
    case 'projection.messages.body':
      return store.readMessageBody(command.request).then(body => ({ kind: 'projection.messages.body_result', body }));
    case 'projection.features.window':
      return store.readFeatureWindow(command.request).then(window => ({ kind: 'projection.features.window_result', window }));
    case 'projection.catalog.begin':
      return store.beginCatalogSnapshot(command.request).then(manifest => ({ kind: 'projection.catalog.manifest', manifest }));
    case 'projection.catalog.page':
      return store.readCatalogPage(command.request).then(page => ({ kind: 'projection.catalog.page_result', page }));
    case 'projection.catalog.detail':
      return store.readCatalogDetail(command.request).then(detail => ({ kind: 'projection.catalog.detail_result', detail }));
    case 'projection.catalog.read':
      return store.readCatalogCommits(command.request).then(batch => ({ kind: 'projection.catalog.batch', batch }));
    case 'projection.view.begin':
      return store.beginViewSnapshot(command.request).then(manifest => ({ kind: 'projection.view.manifest', manifest }));
    case 'projection.view.page':
      return store.readViewSnapshotPage(command.request).then(page => ({ kind: 'projection.view.page_result', page }));
    case 'projection.messages.window':
      return store.readMessageWindow(command.request).then(window => ({ kind: 'projection.messages.window_result', window }));
    case 'projection.scope.read':
      return store.readScope(command.request).then(batch => ({ kind: 'projection.scope.batch', batch }));
    case 'projection.snapshot.begin':
      return store.beginSnapshot(command.request).then(manifest => ({ kind: 'projection.snapshot.manifest', manifest }));
    case 'projection.snapshot.page':
      return store.readSnapshotPage(command.request).then(page => ({ kind: 'projection.snapshot.page_result', page }));
    case 'projection.snapshot.get':
      if (command.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) throw new Error('public_projection_contract_version_mismatch');
      return store.snapshot().then(snapshot => ({ kind: 'projection.snapshot', snapshot }));
    case 'projection.commits.read':
      return store.read(command.request).then(batch => ({ kind: 'projection.commits', batch }));
    default: throw new Error('agent_command_owner_kind_mismatch:projection.query');
  }
}
