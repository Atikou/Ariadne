export interface RuntimeModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly location: 'local' | 'remote';
  readonly enabled?: boolean;
  readonly availability: 'ready' | 'unavailable' | 'checking' | 'error';
  readonly supportsTextChat: boolean;
  readonly supportsAgent: boolean;
  readonly supportsPlan: boolean;
  readonly supportsVision: boolean;
  readonly qualificationState: 'unknown' | 'testing' | 'qualified' | 'rejected';
}

/**
 * Read-only boundary from the current Runtime model domain into Composition.
 * It exposes public-safe catalog facts only; credentials and transport details
 * never cross this port.
 */
export interface RuntimeModelCatalogSource {
  snapshot(): readonly RuntimeModelCatalogEntry[];
}
