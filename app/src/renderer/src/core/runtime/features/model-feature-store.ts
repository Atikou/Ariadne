import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ModelSummary
} from '@ariadne/protocol/public';
import type { SnapshotSource } from './feature-snapshot-store';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export interface ModelFeatureSnapshot {
  readonly models: readonly ModelSummary[];
  readonly modelsReadReady: boolean;
}

export class ModelFeatureStore {
  constructor(
    readonly view: SnapshotSource<ModelFeatureSnapshot>,
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly synchronize: () => Promise<void>
  ) {}
  async qualify(modelId: string): Promise<Extract<
    import('@ariadne/protocol/public').RuntimeResult,
    { kind: 'model.qualification.completed' }
  >> {
    const result = await this.gateway.execute({
      kind: 'model.qualification.run',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      modelId
    });
    if (result.kind !== 'model.qualification.completed' || result.modelId !== modelId) {
      throw new Error('runtime_model_qualification_result_invalid');
    }
    await this.synchronize();
    return result;
  }

  async checkAvailability(modelId: string): Promise<Extract<
    import('@ariadne/protocol/public').RuntimeResult,
    { kind: 'model.availability.completed' }
  >> {
    const result = await this.gateway.execute({
      kind: 'model.availability.check',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      modelId
    });
    if (result.kind !== 'model.availability.completed' || result.modelId !== modelId) {
      throw new Error('runtime_model_availability_result_invalid');
    }
    return result;
  }
}
