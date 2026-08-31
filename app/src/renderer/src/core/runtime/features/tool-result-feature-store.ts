import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type ProtectedToolResultDetail = Extract<
  RuntimeResult,
  { readonly kind: 'agent.tool_result.detail.v3' }
>;

export class ToolResultFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}

  async loadDetail(
    runId: string,
    workspaceId: string,
    effectId: string,
    cursor = 0,
    maxBytes = 32 * 1024
  ): Promise<ProtectedToolResultDetail> {
    const result = await this.gateway.execute({
      kind: 'agent.tool_result.detail.get.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId,
      workspaceId,
      effectId,
      cursor,
      maxBytes
    });
    if (
      result.kind !== 'agent.tool_result.detail.v3'
      || result.runId !== runId
      || result.workspaceId !== workspaceId
      || result.effectId !== effectId
    ) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }
}
