import { createHash } from 'node:crypto';
import type {
  AgentRunRecoveryPayloadReader,
  AgentRunRecoveryQuery,
  RecoverableAgentRun
} from '@ariadne/agent-core';

import type {
  AgentProtectedEffectResultReadResult,
  AgentProtectedEffectResultReader
} from '../ports/AgentToolExecution.js';

const RECOVERY_PAGE_SIZE = 100;

/**
 * Uses the existing protected Effect payload as the spill object. No second
 * file/database, dual write, or independent cleanup lifecycle is introduced.
 */
export class ProtectedAgentEffectResultReader
implements AgentProtectedEffectResultReader {
  public constructor(
    private readonly runs: AgentRunRecoveryQuery,
    private readonly payloads: AgentRunRecoveryPayloadReader
  ) {}

  public async read(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly effectId: string;
    readonly cursor: number;
    readonly maxBytes: number;
  }): Promise<AgentProtectedEffectResultReadResult> {
    validateInput(input);
    const recovery = await this.findRun(input.runId);
    if (recovery === undefined || !recovery.ready || recovery.phase !== 'resumable') {
      throw new Error('agent_protected_effect_result_run_unavailable');
    }
    if (recovery.run.binding.workspace.workspaceId !== input.workspaceId) {
      throw new Error('agent_protected_effect_result_workspace_mismatch');
    }
    const effect = recovery.run.effects.find((candidate) => candidate.effectId === input.effectId);
    const reference = recovery.effectPayloads.find(
      (candidate) => candidate.effectId === input.effectId
    );
    if (
      effect === undefined
      || (effect.state.status !== 'succeeded' && effect.state.status !== 'failed')
      || reference === undefined
      || !reference.hasResult
      || reference.inputDigest !== effect.inputDigest
    ) throw new Error('agent_protected_effect_result_unavailable');

    const result = await this.payloads.loadEffectResult(reference);
    const canonical = JSON.stringify(result);
    const bytes = Buffer.from(canonical, 'utf8');
    const selected = selectUtf8(bytes, input.cursor, input.maxBytes);
    return Object.freeze({
      effectId: effect.effectId,
      toolCallId: effect.toolCallId,
      status: effect.state.status,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      totalBytes: bytes.byteLength,
      cursor: selected.cursor,
      nextCursor: selected.nextCursor,
      content: selected.content,
      complete: selected.nextCursor >= bytes.byteLength
    });
  }

  private async findRun(runId: string): Promise<RecoverableAgentRun | undefined> {
    let after: { readonly createdAt: string; readonly runId: string } | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.runs.listActiveRuns({
        limit: RECOVERY_PAGE_SIZE,
        ...(after === undefined ? {} : { after })
      });
      const found = page.items.find((candidate) => candidate.run.runId === runId);
      if (found !== undefined) return found;
      after = page.nextCursor;
      if (after !== undefined) {
        const key = `${after.createdAt}\0${after.runId}`;
        if (cursors.has(key)) throw new Error('agent_protected_effect_result_cursor_repeated');
        cursors.add(key);
      }
    } while (after !== undefined);
    return undefined;
  }
}

function validateInput(input: {
  readonly runId: string;
  readonly workspaceId: string;
  readonly effectId: string;
  readonly cursor: number;
  readonly maxBytes: number;
}): void {
  if (
    input.runId.length === 0
    || input.workspaceId.length === 0
    || input.effectId.length === 0
    || !Number.isSafeInteger(input.cursor)
    || input.cursor < 0
    || !Number.isSafeInteger(input.maxBytes)
    || input.maxBytes < 1
    || input.maxBytes > 64 * 1024
  ) throw new Error('agent_protected_effect_result_read_invalid');
}

function selectUtf8(
  bytes: Buffer,
  requestedCursor: number,
  maxBytes: number
): { readonly cursor: number; readonly nextCursor: number; readonly content: string } {
  let cursor = Math.min(requestedCursor, bytes.byteLength);
  while (cursor < bytes.byteLength && continuation(bytes[cursor]!)) cursor += 1;
  let end = Math.min(bytes.byteLength, cursor + maxBytes);
  while (end < bytes.byteLength && end > cursor && continuation(bytes[end]!)) end -= 1;
  if (end === cursor && cursor < bytes.byteLength) {
    end += 1;
    while (end < bytes.byteLength && continuation(bytes[end]!)) end += 1;
  }
  return { cursor, nextCursor: end, content: bytes.subarray(cursor, end).toString('utf8') };
}

function continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
