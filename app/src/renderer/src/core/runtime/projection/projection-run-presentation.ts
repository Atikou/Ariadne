import type { PublicRunDocumentHeader, PublicRunDocumentMetadataResult } from '@ariadne/protocol/public';
import type { ProjectionRun, ProjectionCollectionCoverage, ProjectionInboxInput } from './projection-presentation';
import type { ProjectionBodyRepository } from './projection-body-repository';
import type { ProjectionRunDocumentSnapshot } from './projection-run-document-repository';

type Page = Extract<PublicRunDocumentMetadataResult, { status: 'ok' }>;
function coverage(header: PublicRunDocumentHeader, collection: Page['collection'], page: Page | undefined): ProjectionCollectionCoverage {
  const total = header.collections[collection].itemCount;
  if (page === undefined) return { state: total === 0 ? 'complete' : 'unloaded', total, startOrdinal: 0, count: 0, hasEarlier: false, hasMore: total > 0 };
  return { state: page.startOrdinal === 0 && !page.hasMore ? 'complete' : 'partial', total,
    startOrdinal: page.startOrdinal, count: page.rows.length, hasEarlier: page.startOrdinal > 0, hasMore: page.hasMore };
}
export function projectionRunPresentation(snapshot: ProjectionRunDocumentSnapshot, bodies: ProjectionBodyRepository): ProjectionRun {
  const { root, windows } = snapshot;
  const inbox: ProjectionInboxInput[] = (windows.inbox?.rows ?? []).flatMap(proof => {
    if (proof.metadata.collection !== 'inbox') return [];
    const body = bodies.readDocumentItem({ manifest: root.manifest, header: root.header, document: root.document, proof });
    const content = body?.kind === 'document_item' && body.item.collection === 'inbox' ? body.item.value.content : undefined;
    return [{ ...proof.metadata.value, bodyState: content === undefined ? 'unloaded' as const : 'loaded' as const,
      bodyReadToken: root.rootDigest, ...(content === undefined ? {} : { content }) }];
  });
  return { ...root.header.summary, documentToken: root.rootDigest, inbox,
    toolActivities: (windows.toolActivities?.rows ?? []).flatMap(row => row.metadata.collection === 'toolActivities' ? [row.metadata.value] : []),
    collections: { toolActivities: coverage(root.header, 'toolActivities', windows.toolActivities), inbox: coverage(root.header, 'inbox', windows.inbox),
      interactionMessages: coverage(root.header, 'interactionMessages', windows.interactionMessages) } };
}
