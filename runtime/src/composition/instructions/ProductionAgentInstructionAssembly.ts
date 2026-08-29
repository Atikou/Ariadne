import { createHash } from 'node:crypto';

import type {
  AgentInstructionAssemblyRequest,
  AgentInstructionAssemblyService,
  AgentInstructionAssemblySnapshot,
  AgentInstructionBlock,
  AgentInstructionContribution,
  AgentInstructionContributor,
  AgentInstructionContributorDescriptor,
  AgentInstructionScope
} from '../../control/ports/AgentInstructionAssembly.js';

const MAX_BLOCKS = 64;
const MAX_BLOCK_BYTES = 128 * 1024;
const MAX_ASSEMBLY_BYTES = 512 * 1024;
const SAFE_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

export class ProductionAgentInstructionAssembly implements AgentInstructionAssemblyService {
  private readonly contributors: readonly AgentInstructionContributor[];

  public constructor(contributors: readonly AgentInstructionContributor[]) {
    const identities = new Set<string>();
    const orders = new Set<number>();
    for (const contributor of contributors) {
      assertDescriptor(contributor.descriptor);
      if (identities.has(contributor.descriptor.contributorId)) {
        throw new Error(`instruction_contributor_duplicate:${contributor.descriptor.contributorId}`);
      }
      if (orders.has(contributor.descriptor.order)) {
        throw new Error(`instruction_contributor_order_duplicate:${String(contributor.descriptor.order)}`);
      }
      identities.add(contributor.descriptor.contributorId);
      orders.add(contributor.descriptor.order);
    }
    this.contributors = Object.freeze([...contributors].sort(
      (left, right) => left.descriptor.order - right.descriptor.order
        || compareCodeUnits(left.descriptor.contributorId, right.descriptor.contributorId)
    ));
  }

  public async assemble(
    request: AgentInstructionAssemblyRequest,
    signal: AbortSignal
  ): Promise<AgentInstructionAssemblySnapshot> {
    assertRequest(request);
    signal.throwIfAborted();
    const blocks: AgentInstructionBlock[] = [];
    let totalBytes = 0;
    const blockIdentities = new Set<string>();
    for (const contributor of this.contributors) {
      if (!contributor.descriptor.executionModes.includes(request.executionMode)) continue;
      signal.throwIfAborted();
      const contributions = await contributor.contribute(request, signal);
      signal.throwIfAborted();
      if (!Array.isArray(contributions)) throw new Error('instruction_contributions_invalid');
      for (const [index, contribution] of contributions.entries()) {
        assertContribution(contribution, request);
        const identity = `${contributor.descriptor.contributorId}:${contribution.blockId}`;
        if (blockIdentities.has(identity)) throw new Error(`instruction_block_duplicate:${identity}`);
        blockIdentities.add(identity);
        const bytes = Buffer.byteLength(contribution.content, 'utf8');
        totalBytes += bytes;
        if (bytes > MAX_BLOCK_BYTES) throw new Error(`instruction_block_too_large:${identity}`);
        if (totalBytes > MAX_ASSEMBLY_BYTES) throw new Error('instruction_assembly_too_large');
        if (blocks.length >= MAX_BLOCKS) throw new Error('instruction_block_count_exceeded');
        blocks.push(Object.freeze({
          blockId: contribution.blockId,
          contributorId: contributor.descriptor.contributorId,
          contributorVersion: contributor.descriptor.version,
          order: contributor.descriptor.order * 1_000 + index,
          scope: Object.freeze({ ...contribution.scope }),
          revision: digest(contribution.content),
          content: contribution.content
        }));
      }
    }
    return Object.freeze({
      snapshotVersion: 1,
      complete: true,
      subject: Object.freeze({ ...request }),
      blocks: Object.freeze(blocks)
    });
  }
}

export function renderAgentInstructionSnapshot(
  snapshot: AgentInstructionAssemblySnapshot,
  request: AgentInstructionAssemblyRequest
): readonly string[] {
  assertSnapshot(snapshot, request);
  return Object.freeze(snapshot.blocks.map((block) => [
    `[AGENT_INSTRUCTION contributor=${block.contributorId} version=${block.contributorVersion} block=${block.blockId} order=${String(block.order)} scope=${renderScope(block.scope)} revision=${block.revision}]`,
    block.content,
    '[/AGENT_INSTRUCTION]'
  ].join('\n')));
}

function assertDescriptor(value: AgentInstructionContributorDescriptor): void {
  if (!SAFE_ID.test(value.contributorId) || !SAFE_VERSION.test(value.version)) {
    throw new Error('instruction_contributor_descriptor_invalid');
  }
  if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 1_000_000) {
    throw new Error(`instruction_contributor_order_invalid:${value.contributorId}`);
  }
  if (value.executionModes.length === 0 || new Set(value.executionModes).size !== value.executionModes.length) {
    throw new Error(`instruction_contributor_modes_invalid:${value.contributorId}`);
  }
  if (value.executionModes.some((mode) => !(['agent', 'plan', 'chat'] as const).includes(mode))) {
    throw new Error(`instruction_contributor_modes_invalid:${value.contributorId}`);
  }
}

function assertRequest(value: AgentInstructionAssemblyRequest): void {
  if (
    value === null
    || typeof value !== 'object'
    || !nonEmpty(value.runId)
    || !nonEmpty(value.sessionId)
    || !nonEmpty(value.workspaceId)
    || !(['agent', 'plan', 'chat'] as const).includes(value.executionMode)
  ) throw new Error('instruction_assembly_request_invalid');
}

function assertContribution(
  value: AgentInstructionContribution,
  request: AgentInstructionAssemblyRequest
): void {
  if (
    value === null
    || typeof value !== 'object'
    || !SAFE_ID.test(value.blockId)
    || typeof value.content !== 'string'
    || value.content.length === 0
  ) {
    throw new Error('instruction_contribution_invalid');
  }
  assertScope(value.scope, request);
}

function assertSnapshot(
  snapshot: AgentInstructionAssemblySnapshot,
  request: AgentInstructionAssemblyRequest
): void {
  assertRequest(request);
  if (
    snapshot.snapshotVersion !== 1
    || snapshot.complete !== true
    || snapshot.subject.runId !== request.runId
    || snapshot.subject.sessionId !== request.sessionId
    || snapshot.subject.workspaceId !== request.workspaceId
    || snapshot.subject.executionMode !== request.executionMode
    || !Array.isArray(snapshot.blocks)
    || snapshot.blocks.length > MAX_BLOCKS
  ) throw new Error('instruction_assembly_snapshot_invalid');
  let previousOrder = -1;
  let totalBytes = 0;
  const identities = new Set<string>();
  for (const block of snapshot.blocks) {
    const identity = `${block.contributorId}:${block.blockId}`;
    const bytes = Buffer.byteLength(block.content, 'utf8');
    totalBytes += bytes;
    if (
      !SAFE_ID.test(block.contributorId)
      || !SAFE_VERSION.test(block.contributorVersion)
      || !SAFE_ID.test(block.blockId)
      || !Number.isSafeInteger(block.order)
      || block.order <= previousOrder
      || identities.has(identity)
      || !/^sha256:[a-f0-9]{64}$/u.test(block.revision)
      || block.revision !== digest(block.content)
      || bytes > MAX_BLOCK_BYTES
      || totalBytes > MAX_ASSEMBLY_BYTES
    ) throw new Error(`instruction_assembly_block_invalid:${identity}`);
    assertScope(block.scope, request);
    previousOrder = block.order;
    identities.add(identity);
  }
}

function assertScope(scope: AgentInstructionScope, request: AgentInstructionAssemblyRequest): void {
  if (
    (scope.kind === 'workspace' && scope.workspaceId === request.workspaceId)
    || (scope.kind === 'run' && scope.runId === request.runId)
    || (scope.kind === 'mode' && scope.mode === request.executionMode)
  ) return;
  throw new Error('instruction_scope_contradicts_subject');
}

function renderScope(scope: AgentInstructionScope): string {
  if (scope.kind === 'workspace') return `workspace:${encodeURIComponent(scope.workspaceId)}`;
  if (scope.kind === 'run') return `run:${encodeURIComponent(scope.runId)}`;
  return `mode:${scope.mode}`;
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
