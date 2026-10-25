import type {
  ProjectionCommit,
  PublicProjectionReadBatch,
  PublicProjectionReadRequest,
  PublicProjectionSnapshot
} from '@ariadne/protocol/public';

export interface PublicProjectionCommitSink {
  append(commit: ProjectionCommit): Promise<unknown>;
}

export interface PublicProjectionQueryStore {
  snapshot(): Promise<PublicProjectionSnapshot>;
  read(request: PublicProjectionReadRequest): Promise<PublicProjectionReadBatch>;
}
