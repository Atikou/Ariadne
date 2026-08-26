import type {
  ProjectionCommitV3,
  PublicProjectionReadBatchV3,
  PublicProjectionReadRequestV3,
  PublicProjectionSnapshotV3
} from '@ariadne/protocol/public';

export interface PublicProjectionCommitSink {
  append(commit: ProjectionCommitV3): Promise<unknown>;
}

export interface PublicProjectionQueryStore {
  snapshot(): Promise<PublicProjectionSnapshotV3>;
  read(request: PublicProjectionReadRequestV3): Promise<PublicProjectionReadBatchV3>;
}
