import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type HumanSkillCommand = Extract<
  RuntimeResult,
  { readonly kind: 'skill.commands.query_result.v3' }
>['commands'][number];

export type LoadedHumanSkill = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.loaded.v3' }
>;

export type HumanSkillResource = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.resource.v3' }
>;

export class HumanSkillFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}

  async queryCommands(workspaceId: string): Promise<readonly HumanSkillCommand[]> {
    const result = await this.gateway.execute({
      kind: 'skill.commands.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId
    });
    if (result.kind !== 'skill.commands.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.commands;
  }

  async loadCommand(
    workspaceId: string,
    name: string,
    revision: string
  ): Promise<LoadedHumanSkill> {
    const result = await this.gateway.execute({
      kind: 'skill.command.load.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision
    });
    if (result.kind !== 'skill.command.loaded.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async readResource(
    workspaceId: string,
    name: string,
    revision: string,
    relativePath: string
  ): Promise<HumanSkillResource> {
    const result = await this.gateway.execute({
      kind: 'skill.command.resource.read.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision,
      relativePath
    });
    if (result.kind !== 'skill.command.resource.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }
}
