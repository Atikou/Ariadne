import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeResult
} from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type HumanSkillCommand = Extract<
  RuntimeResult,
  { readonly kind: 'skill.commands.query_result' }
>['commands'][number];

export type LoadedHumanSkill = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.loaded' }
>;

export type HumanSkillResource = Extract<
  RuntimeResult,
  { readonly kind: 'skill.command.resource' }
>;

export class HumanSkillFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}

  async queryCommands(workspaceId: string): Promise<readonly HumanSkillCommand[]> {
    const result = await this.gateway.execute({
      kind: 'skill.commands.query',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId
    });
    if (result.kind !== 'skill.commands.query_result') {
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
      kind: 'skill.command.load',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision
    });
    if (result.kind !== 'skill.command.loaded') {
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
      kind: 'skill.command.resource.read',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      name,
      revision,
      relativePath
    });
    if (result.kind !== 'skill.command.resource') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }
}
