import type { PublicRunDocumentCommit } from '@ariadne/protocol/public';
import type { RunDocumentPlan } from './RunDocumentPlan.js';

/** A complete document publication through the existing Projection owner.
 * Preparation alone is never a successful append or permission to ACK. */
export interface PublicProjectionRunDocumentCommitSinkV1 {
  appendRunDocument(commit: PublicRunDocumentCommit, plan: RunDocumentPlan): Promise<unknown>;
}
