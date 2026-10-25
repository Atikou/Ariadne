export interface ProjectionDetailActions {
  openDetail(aggregateId: string): Promise<void>;
  navigate(direction: 'next' | 'previous'): Promise<void>;
  navigateSession?(direction: 'next' | 'previous'): Promise<void>;
}

/** Read navigation never submits a domain mutation or materializes a summary as a body. */
export class ProjectionFeatureNavigation {
  constructor(private readonly navigator?: (direction: 'next' | 'previous') => Promise<void>) {}
  navigate(direction: 'next' | 'previous'): Promise<void> {
    if (this.navigator === undefined) throw new Error('projection_navigation_unavailable');
    return this.navigator(direction);
  }
}
export class ProjectionDetailFeature extends ProjectionFeatureNavigation {
  constructor(private readonly reads?: ProjectionDetailActions) { super(reads?.navigate); }
  navigateSession(direction: 'next' | 'previous'): Promise<void> {
    if (this.reads?.navigateSession === undefined) throw new Error('projection_session_navigation_unavailable');
    return this.reads.navigateSession(direction);
  }
  openDetail(aggregateId: string): Promise<void> {
    if (this.reads === undefined) throw new Error('projection_detail_reads_unavailable');
    return this.reads.openDetail(aggregateId);
  }
}
