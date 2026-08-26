import type {
  PublicDiagnosticProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type DiagnosticsProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'diagnostics' }
>;

export class DiagnosticsStore extends ProjectionFeatureStore<PublicDiagnosticProjectionV3> {
  constructor() {
    super((diagnostic) => diagnostic.diagnosticId);
  }
}
