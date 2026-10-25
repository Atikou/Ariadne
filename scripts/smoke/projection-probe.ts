import { PublicProjectionCatalogPageChain, PublicProjectionViewPageChain, RunDocumentMetadataPageChain,
  canonicalPublicProjectionJson, type PublicProjectionCatalogManifest, type PublicRunDocumentRootResult,
  type PublicRunDocumentItem, type PublicRunCatalogSummary,
  type PublicSessionProjection, type PublicDecisionProjection, type PublicMessageProjection,
  type PublicInferenceStreamProjection, type PublicModelProjection, type PublicDiagnosticProjection } from '@ariadne/protocol/public';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client';
import { ProjectionBodyRepository } from '../../app/src/renderer/src/core/runtime/projection/projection-body-repository';
import type { AriadneApi } from '../../app/src/shared/contract';

type Root = Extract<PublicRunDocumentRootResult, { status: 'ok' }>;
type Collection = PublicRunDocumentItem['collection'];
interface Selection {
  toolSessionIds?: readonly string[];
  toolRunIds?: readonly string[];
  toolStatuses?: readonly PublicRunCatalogSummary['status'][];
  runCollections?: Readonly<Record<string, readonly Collection[]>>;
}
type FixtureRun = PublicRunCatalogSummary & Partial<{
  toolActivities: Extract<PublicRunDocumentItem, { collection: 'toolActivities' }>['value'][];
  inbox: Extract<PublicRunDocumentItem, { collection: 'inbox' }>['value'][];
  interactionMessages: Extract<PublicRunDocumentItem, { collection: 'interactionMessages' }>['value'][];
}>;

/** Test-only fixture windows over the shipped bridge/client/verifiers. No global
 * snapshot, full Run assembly, persistent cache or new IPC enters the product.
 * Limits are acceptance fixture limits: exceeding one fails instead of truncating. */
export function createProjectionProbe(api: AriadneApi['runtime']) {
  const client = new ProjectionRuntimeClient(api);
  const requireOk = <T extends { status: string }>(value: T): Extract<T, { status: 'ok' }> => {
    if (value.status !== 'ok') throw new Error(`smoke_projection_read:${value.status}:${'reason' in value ? value.reason : ''}`);
    return value as Extract<T, { status: 'ok' }>;
  };
  const size = (value: unknown) => new TextEncoder().encode(canonicalPublicProjectionJson(value)).length;
  const catalog = async (manifest: PublicProjectionCatalogManifest) => {
    const page = requireOk(await client.readCatalogPage(manifest, undefined, 128));
    await new PublicProjectionCatalogPageChain(manifest).accept(page);
    if (page.hasMore) throw new Error(`smoke_fixture_catalog_limit:${manifest.feature}`);
    return page.rows;
  };
  const root = async (manifest: PublicProjectionCatalogManifest, run: PublicRunCatalogSummary) => {
    const value = requireOk(await client.readRunDocument({ queryContractVersion: '1.0', manifest,
      runId: run.runId, expectedRunVersion: run.version }));
    if (canonicalPublicProjectionJson(value.header.summary) !== canonicalPublicProjectionJson(run)) {
      throw new Error('smoke_document_summary_mismatch');
    }
    return value;
  };
  const collection = async (document: Root, name: Collection, bodies: ProjectionBodyRepository, reserve: (bytes: number) => void) => {
    const request = { queryContractVersion: '1.0', manifest: document.manifest,
      document: document.document, collection: name, limit: 128 };
    const page = requireOk(await new RunDocumentMetadataPageChain().accept(request,
      await client.readRunDocumentMetadata(request)));
    if (canonicalPublicProjectionJson(page.header) !== canonicalPublicProjectionJson(document.header)) throw new Error('smoke_collection_root_mismatch');
    if (page.hasMore || page.rows.length !== document.header.collections[name].itemCount) {
      throw new Error(`smoke_fixture_collection_limit:${name}`);
    }
    const values: PublicRunDocumentItem['value'][] = [];
    let bytes = 0;
    for (const proof of page.rows) {
      if (name === 'toolActivities') {
        if (proof.metadata.collection !== 'toolActivities') throw new Error('smoke_tool_metadata_invalid');
        reserve(size(proof.metadata.value));
        values.push(proof.metadata.value);
      }
      else {
        bytes += proof.descriptor.itemBytes;
        if (bytes > 8 * 1024 * 1024) throw new Error('smoke_fixture_collection_byte_limit');
        reserve(proof.descriptor.itemBytes);
        const body = await bodies.loadDocumentItem({ manifest: document.manifest, header: document.header,
          document: document.document, proof });
        if (body.status !== 'loaded' || body.body.kind !== 'document_item' || body.body.item.collection !== name) {
          throw new Error('smoke_document_item_unavailable');
        }
        values.push(body.body.item.value);
      }
    }
    return values;
  };
  const readFixtureWindow = async (workspaceId: string, selection: Selection = {}) => {
    const bodies = new ProjectionBodyRepository(client);
    let retainedBytes = 0;
    const reserve = (bytes: number) => {
      retainedBytes += bytes;
      if (retainedBytes > 16 * 1024 * 1024) throw new Error('smoke_fixture_window_byte_limit');
    };
    // Different Sessions have their own explicit C. A Run and all of its body
    // reads below always share that Session's immutable unfiltered manifest.
    const directory = await client.beginViewSnapshot({ kind: 'directory', workspaceId }, ['models', 'sessions']);
    const page = await new PublicProjectionViewPageChain(directory).accept(await client.readViewPage(directory));
    if (page.hasMore) throw new Error('smoke_fixture_directory_limit');
    const sessions: PublicSessionProjection[] = [], models: PublicModelProjection[] = [], diagnostics: PublicDiagnosticProjection[] = [];
    for (const change of page.changes) {
      if (change.operation === 'delete' && change.dto === null) continue;
      if (change.dto === null || change.operation !== 'upsert') throw new Error('smoke_directory_row_invalid');
      if (change.feature === 'sessions') sessions.push(change.dto);
      else if (change.feature === 'models') models.push(change.dto);
      else throw new Error('smoke_directory_feature_invalid');
    }
    const diagnosticManifest = await client.beginViewSnapshot({ kind: 'directory', workspaceId }, ['diagnostics']);
    const diagnosticWindow = requireOk(await client.readFeatureWindow(diagnosticManifest,
      { feature: 'diagnostics', filter: 'all', limit: 32 }));
    for (const change of diagnosticWindow.changes) {
      if (change.feature !== 'diagnostics' || change.dto === null) throw new Error('smoke_diagnostic_row_invalid');
      diagnostics.push(change.dto);
    }
    const diagnosticCoverage = { state: diagnosticWindow.hasEarlier ? 'partial' : 'complete', hasEarlier: diagnosticWindow.hasEarlier,
      cursor: diagnosticManifest.boundaryCursor, digest: diagnosticManifest.boundaryDigest };
    if (sessions.length > 32) throw new Error('smoke_fixture_session_limit');
    reserve(size({ sessions, models, diagnostics }));
    const runs: FixtureRun[] = [], messages: PublicMessageProjection[] = [], inferenceStreams: PublicInferenceStreamProjection[] = [];
    const boundaries: { sessionId: string; cursor: number; digest: string }[] = [];
    const decisions: PublicDecisionProjection[] = [];
    for (const session of sessions) {
      const manifest = await client.beginCatalog({ scope: { kind: 'session', workspaceId, sessionId: session.sessionId }, feature: 'runs', filter: 'all' });
      boundaries.push({ sessionId: session.sessionId, cursor: manifest.boundaryCursor, digest: manifest.boundaryDigest });
      for (const row of await catalog(manifest)) {
        if (row.feature !== 'runs') throw new Error('smoke_run_catalog_feature_invalid');
        const names = new Set(selection.runCollections?.[row.dto.runId] ?? []);
        if (selection.toolSessionIds?.includes(session.sessionId) || selection.toolRunIds?.includes(row.dto.runId)
          || selection.toolStatuses?.includes(row.dto.status)) names.add('toolActivities');
        const run: FixtureRun = { ...row.dto };
        if (names.size > 0) {
          const document = await root(manifest, row.dto);
          for (const name of names) Object.assign(run, { [name]: await collection(document, name, bodies, reserve) });
        }
        reserve(size(row.dto));
        runs.push(run);
        if (runs.length > 128) throw new Error('smoke_fixture_run_limit');
      }
      const window = requireOk(await client.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest,
        window: { kind: 'latest', limit: 64 } }));
      if (window.hasEarlier || window.hasLater) throw new Error('smoke_fixture_message_limit');
      for (const row of window.rows) {
        // Reserve the declared document bytes before dispatch. Standalone
        // messages use the released scalar body ceiling, verified by the client.
        const reserved = row.kind === 'run_document' ? row.proof.descriptor.itemBytes : 1024 * 1024;
        reserve(reserved);
        const body = await bodies.loadMessage(manifest, row);
        if (body.status !== 'loaded') throw new Error('smoke_message_unavailable');
        if (body.body.kind === 'message') {
          reserve(size(body.body.message) - reserved); messages.push(body.body.message);
        } else if (body.body.item.collection === 'interactionMessages') {
          reserve(size(body.body.item.value) - reserved); messages.push(body.body.item.value);
        }
        else throw new Error('smoke_message_collection_invalid');
      }
      const streams = requireOk(await client.readConversationInferenceWindow({ queryVersion: '1.0', manifest,
        window: { feature: 'inference_streams', filter: 'all', limit: 128 } }));
      if (streams.hasEarlier) throw new Error('smoke_fixture_inference_limit');
      for (const change of streams.changes) {
        if (change.feature !== 'inference_streams' || change.dto === null) throw new Error('smoke_inference_row_invalid');
        reserve(size(change.dto)); inferenceStreams.push(change.dto);
      }
    }
    const decisionManifest = await client.beginCatalog({ scope: { kind: 'decisions', workspaceId }, feature: 'decisions', filter: 'all' });
    for (const row of await catalog(decisionManifest)) {
      if (row.feature !== 'decisions') throw new Error('smoke_decision_catalog_feature_invalid');
      const detail = requireOk(await client.readCatalogDetail(decisionManifest, row.dto.decisionId));
      if (detail.change === null || detail.change.feature !== 'decisions' || detail.change.dto === null) throw new Error('smoke_decision_detail_invalid');
      reserve(size(detail.change.dto)); decisions.push(detail.change.dto);
    }
    const result = { sessions, models, diagnostics, diagnosticCoverage, runs, messages, inferenceStreams, decisions, boundaries };
    if (size(result) > 16 * 1024 * 1024) throw new Error('smoke_fixture_window_byte_limit');
    // No body cache survives a probe window, even when the caller keeps evidence.
    bodies.invalidate();
    return result;
  };
  const inboxAbsent = async (workspaceId: string, sessionId: string, runId: string, inputId: string) => {
    const manifest = await client.beginCatalog({ scope: { kind: 'session', workspaceId, sessionId }, feature: 'runs', filter: 'all' });
    const document = requireOk(await client.readRunDocument({ queryContractVersion: '1.0', manifest, runId }));
    const input = requireOk(await client.readRunDocumentInbox({ queryContractVersion: '1.0', manifest, document: document.document, inputId }));
    return input.proof === null;
  };
  return { readFixtureWindow, inboxAbsent };
}

export function install() {
  const target = window as Window & { ariadne: AriadneApi; __ariadneSmokeProjection?: ReturnType<typeof createProjectionProbe> };
  target.__ariadneSmokeProjection = createProjectionProbe(target.ariadne.runtime);
}
