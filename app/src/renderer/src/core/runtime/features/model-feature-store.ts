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
  async evaluateQuality(modelId:string):Promise<Extract<import('@ariadne/protocol/public').RuntimeResult,{kind:'model.quality.completed'}>> {
    const result=await this.gateway.execute({kind:'model.quality.evaluate',contractVersion:PUBLIC_PROJECTION_CONTRACT_VERSION,modelId});
    if(result.kind!=='model.quality.completed'||result.modelId!==modelId)throw new Error('runtime_model_quality_result_invalid');
    await this.synchronize();return result;
  }

  async qualify(modelId: string): Promise<Extract<
    import('@ariadne/protocol/public').RuntimeResult,
    { kind: 'model.qualification.completed' }
  >> {
    const result = await this.gateway.execute({
      kind: 'model.qualification.run',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      modelId
    });
    if (result.kind !== 'model.qualification.completed') {
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
    if (result.kind !== 'model.availability.completed') {
      throw new Error('runtime_model_availability_result_invalid');
    }
    return result;
  }
}
