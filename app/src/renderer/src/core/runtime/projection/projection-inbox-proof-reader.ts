import type { PublicSessionProjection } from '@ariadne/protocol/public';
import type { VerifiedAgentInboxIdentity } from '../agent-input-delivery';
import { ProjectionCatalogResetSignal, type ProjectionRuntimeClient } from './projection-runtime-client';
import type { ProjectionRunDocumentRepository } from './projection-run-document-repository';

interface InputReference { readonly runId: string; readonly sessionId: string; readonly inputId: string }

/** Settlement never reads a full Run or infers acceptance from page omission.
 * Each Session has one exact all-Runs manifest; every input has its own proof. */
export async function observeProjectionInboxProofs(client: ProjectionRuntimeClient, documents: ProjectionRunDocumentRepository,
  references: readonly InputReference[], readSession: (id: string) => Promise<PublicSessionProjection | null>,
  current: () => boolean, streamId: () => string | null, observer: (identity: VerifiedAgentInboxIdentity) => void): Promise<void> {
  if (references.length > 100) throw new Error('projection_inbox_proof_reference_capacity_exceeded');
  const groups = new Map<string, InputReference[]>(), seen = new Set<string>();
  for (const reference of references) {
    const identity = JSON.stringify([reference.runId, reference.sessionId, reference.inputId]);
    if (seen.has(identity)) continue; seen.add(identity);
    const group = groups.get(reference.sessionId) ?? []; group.push(reference); groups.set(reference.sessionId, group);
  }
  // Finish each Session before leasing another. Interleaved sender records
  // cannot exhaust the finite lease owner and then revisit an expired C.
  for (const [sessionId, group] of groups) {
    if (!current()) return;
    const session = await readSession(sessionId); if (!current()) return;
    if (session === null) continue;
    const manifest = await client.beginCatalog({ scope: { kind: 'session', sessionId: session.sessionId,
      workspaceId: session.workspaceId }, feature: 'runs', filter: 'all' });
    if (!current()) return;
    if (manifest.streamId !== streamId()) throw new ProjectionCatalogResetSignal('stream_mismatch');
    for (const reference of group) {
      if (documents.read(manifest, reference.runId) === null) {
        const loaded = await documents.load(manifest, reference.runId); if (!current()) return;
        if (loaded.status !== 'published') continue;
      }
      const lookup = await documents.lookupInbox(manifest, reference.runId, reference.inputId); if (!current()) return;
      if (lookup.status !== 'published') continue;
      const exact = lookup.snapshot.exactInbox.find(input => input.inputId === reference.inputId);
      if (exact === undefined) throw new Error('projection_inbox_exact_proof_required');
      const metadata = exact.proof?.metadata;
      if (metadata !== undefined && metadata.collection !== 'inbox') throw new Error('projection_inbox_metadata_kind_invalid');
      if (exact.header.summary.sessionId !== reference.sessionId) throw new Error('projection_inbox_session_binding_invalid');
      observer({ runId: exact.document.runId, sessionId: exact.header.summary.sessionId,
        runVersion: exact.document.runVersion, input: metadata?.value ?? null });
      if (!current()) return;
    }
  }
}
