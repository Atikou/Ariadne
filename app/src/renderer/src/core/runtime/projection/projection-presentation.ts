import type { PublicSessionProjection, PublicMessageProjection, PublicRunCatalogSummary, PublicAgentInboxInput, PublicDecisionProjection,
  PublicModelProjection, PublicDiagnosticProjection, PublicInferenceStreamProjection, PublicToolActivityProjection } from '@ariadne/protocol/public';

/** Renderer state, not a body-free Public Message DTO. */
export type ProjectionMessage = Omit<PublicMessageProjection, 'content'> & {
  readonly content?: string;
  readonly bodyState?: 'unloaded' | 'loaded';
  readonly bodyReadToken?: string;
};

export interface ProjectionCollectionCoverage {
  readonly state: 'unloaded' | 'partial' | 'complete';
  readonly total: number;
  readonly startOrdinal: number;
  readonly count: number;
  readonly hasEarlier: boolean;
  readonly hasMore: boolean;
}
export type ProjectionInboxInput = Omit<PublicAgentInboxInput, 'content'> & {
  readonly content?: string;
  readonly bodyState: 'unloaded' | 'loaded';
  readonly bodyReadToken: string;
};
/** A root and verified windows, not a complete Public Run DTO. Interaction
 * history belongs to the merged Conversation metadata range. */
export interface ProjectionRun extends PublicRunCatalogSummary {
  readonly documentToken: string;
  readonly collections: Readonly<Record<'toolActivities' | 'inbox' | 'interactionMessages', ProjectionCollectionCoverage>>;
  readonly toolActivities: readonly PublicToolActivityProjection[];
  readonly inbox: readonly ProjectionInboxInput[];
}

/** Verified, bounded bodies used by presentation. Cursor is the directory
 * watermark; each read range retains its own manifest and scan watermark. */
export interface ProjectionPresentation {
  readonly streamId: string | null;
  readonly cursor: number;
  readonly cursorDigest: string;
  readonly resetEpoch: number;
  readonly integrityError: string | null;
  readonly sessions: readonly PublicSessionProjection[];
  readonly messages: readonly ProjectionMessage[];
  readonly runs: readonly ProjectionRun[];
  readonly decisions: readonly PublicDecisionProjection[];
  readonly models: readonly PublicModelProjection[];
  readonly diagnostics: readonly PublicDiagnosticProjection[];
  readonly inferenceStreams: readonly PublicInferenceStreamProjection[];
}
