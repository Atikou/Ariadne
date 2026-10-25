import { publicProjectionCanonicalIdSchema, publicProjectionDigestSchema } from '@ariadne/protocol/public';
import type { RuntimeRun } from '../runtime-projection-presenter';
import { ProjectionDetailFeature, type ProjectionDetailActions } from './projection-feature-navigation';

export interface RunDetailActions extends ProjectionDetailActions {
  readCollection(runId: string, sessionId: string, token: string, collection: 'toolActivities' | 'inbox', direction: 'first' | 'next'): Promise<void>;
  readInboxBody(runId: string, sessionId: string, inputId: string, token: string): Promise<void>;
}
/** Validated navigation/body requests stay separate from domain mutations. */
export class RunDocumentFeatureReads extends ProjectionDetailFeature {
  constructor(private readonly readActions?: RunDetailActions) { super(readActions); }
  readCollection(run: RuntimeRun, collection: 'toolActivities' | 'inbox', direction: 'first' | 'next'): Promise<void> {
    if (run.sessionId === undefined || this.readActions === undefined) throw new Error('projection_run_collection_reads_unavailable');
    return this.readActions.readCollection(run.runId, run.sessionId, run.documentToken, collection, direction);
  }
  loadInboxBody(runId: string, sessionId: string, inputId: string, token: string): Promise<void> {
    publicProjectionCanonicalIdSchema.parse(runId); publicProjectionCanonicalIdSchema.parse(sessionId);
    publicProjectionCanonicalIdSchema.parse(inputId); publicProjectionDigestSchema.parse(token);
    if (this.readActions === undefined) throw new Error('projection_inbox_body_reads_unavailable');
    return this.readActions.readInboxBody(runId, sessionId, inputId, token);
  }
}
