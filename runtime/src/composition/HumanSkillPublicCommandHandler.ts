import type { RuntimeResult } from '@ariadne/protocol/public';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { HumanSkillCatalog } from '../control/ports/HumanSkillCatalog.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import {
  defineAgentPublicCommandOwner,
  type AgentPublicCommandOwner
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

type HumanSkillCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind:
    | 'skill.commands.query.v3'
    | 'skill.command.load.v3'
    | 'skill.command.resource.read.v3';
}>;

const MAX_PUBLIC_RESOURCE_BYTES = 192 * 1024;

export function createHumanSkillCommandOwners(
  handler: HumanSkillPublicCommandHandler | undefined
): readonly AgentPublicCommandOwner[] {
  return Object.freeze([
    defineAgentPublicCommandOwner('skills.human', [
      'skill.commands.query.v3', 'skill.command.load.v3', 'skill.command.resource.read.v3'
    ], (envelope, command) => handler?.execute(envelope, command)
      ?? Promise.resolve(completedPublicError(
        envelope, 'skill_catalog_unavailable',
        'The human Skill command catalog is unavailable.', false
      )), async () => ({ kind: 'not_committed' }))
  ]);
}

/** Human-only Skill command surface. It never enters Agent admission or starts a Run. */
export class HumanSkillPublicCommandHandler {
  private readonly authorizedWorkspaceIds: ReadonlySet<string>;

  public constructor(
    private readonly catalog: HumanSkillCatalog,
    authorizedWorkspaceIds: readonly string[]
  ) {
    this.authorizedWorkspaceIds = new Set(authorizedWorkspaceIds);
  }

  public async execute(
    envelope: RuntimeCommandEnvelope,
    command: HumanSkillCommand
  ): Promise<RuntimeApplicationCommandResult> {
    envelope.signal.throwIfAborted();
    if (
      this.authorizedWorkspaceIds.size > 0
      && !this.authorizedWorkspaceIds.has(command.workspaceId)
    ) return completedPublicError(
      envelope,
      'workspace_not_authorized',
      'The Workspace is not authorized by this Runtime bootstrap.',
      false
    );
    try {
      switch (command.kind) {
        case 'skill.commands.query.v3':
          return this.query(envelope, command.workspaceId);
        case 'skill.command.load.v3':
          return this.load(envelope, command);
        case 'skill.command.resource.read.v3':
          return this.readResource(envelope, command);
      }
    } catch (error) {
      envelope.signal.throwIfAborted();
      return completedPublicError(
        envelope,
        humanSkillFailureCode(error),
        'The human Skill command could not be resolved from the pinned catalog.',
        false
      );
    }
  }

  private async query(
    envelope: RuntimeCommandEnvelope,
    workspaceId: string
  ): Promise<RuntimeApplicationCommandResult> {
    const snapshot = await this.catalog.snapshot(workspaceId, envelope.signal);
    return completed({
      kind: 'skill.commands.query_result.v3',
      workspaceId,
      catalogDigest: snapshot.catalogDigest,
      complete: snapshot.complete,
      source: snapshot.source,
      commands: snapshot.skills
        .filter((skill) => skill.invocation.userInvocable)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          revision: skill.revision,
          layer: skill.layer
        }))
    });
  }

  private async load(
    envelope: RuntimeCommandEnvelope,
    command: Extract<HumanSkillCommand, { readonly kind: 'skill.command.load.v3' }>
  ): Promise<RuntimeApplicationCommandResult> {
    const skill = await this.catalog.loadForUser(
      command.workspaceId,
      command.name,
      command.revision,
      envelope.signal
    );
    return completed({
      kind: 'skill.command.loaded.v3',
      workspaceId: command.workspaceId,
      name: skill.name,
      description: skill.description,
      revision: skill.revision,
      layer: skill.layer,
      body: skill.body,
      resources: skill.resources.map((resource) => ({ ...resource }))
    });
  }

  private async readResource(
    envelope: RuntimeCommandEnvelope,
    command: Extract<HumanSkillCommand, {
      readonly kind: 'skill.command.resource.read.v3';
    }>
  ): Promise<RuntimeApplicationCommandResult> {
    const resource = await this.catalog.readResourceForUser(
      command.workspaceId,
      command.name,
      command.revision,
      command.relativePath,
      envelope.signal
    );
    if (resource.byteLength > MAX_PUBLIC_RESOURCE_BYTES) {
      throw new Error('skill_resource_public_limit_exceeded');
    }
    const utf8 = decodeTextResource(resource.mediaType, resource.bytes);
    return completed({
      kind: 'skill.command.resource.v3',
      workspaceId: command.workspaceId,
      name: command.name,
      revision: command.revision,
      relativePath: resource.relativePath,
      mediaType: resource.mediaType,
      encoding: utf8 === undefined ? 'base64' : 'utf8',
      content: utf8 ?? Buffer.from(resource.bytes).toString('base64')
    });
  }
}

function completed(result: RuntimeResult): RuntimeApplicationCommandResult {
  return { outcome: { ok: true, result }, settlement: 'completed' };
}

function decodeTextResource(mediaType: string, bytes: Uint8Array): string | undefined {
  if (
    !mediaType.startsWith('text/')
    && mediaType !== 'application/json'
    && mediaType !== 'application/yaml'
    && mediaType !== 'image/svg+xml'
  ) return undefined;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function humanSkillFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'skill_user_invocation_disabled') return code;
  if (code === 'skill_resource_public_limit_exceeded') return code;
  if (code.startsWith('skill_')) return 'skill_command_unavailable';
  return 'skill_command_failed';
}
