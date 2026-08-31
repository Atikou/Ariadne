import { createHash } from 'node:crypto';
import type {
  AgentProtectedEffectResultAuthority,
  AgentProtectedEffectResultReadResult,
  AgentProtectedEffectResultReader
} from '../ports/AgentToolExecution.js';

/**
 * Uses the existing protected Effect payload as the spill object. No second
 * file/database, dual write, or independent cleanup lifecycle is introduced.
 */
export class ProtectedAgentEffectResultReader
implements AgentProtectedEffectResultReader {
  public constructor(
    private readonly authority: AgentProtectedEffectResultAuthority
  ) {}

  public async read(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly effectId: string;
    readonly cursor: number;
    readonly maxBytes: number;
  }): Promise<AgentProtectedEffectResultReadResult> {
    validateInput(input);
    const record = await this.authority.loadProtectedEffectResultAuthority(
      input.runId,
      input.effectId
    );
    if (record === null) {
      throw new Error('agent_protected_effect_result_run_unavailable');
    }
    if (record.workspaceId !== input.workspaceId) {
      throw new Error('agent_protected_effect_result_workspace_mismatch');
    }
    const canonical = JSON.stringify(record.result);
    const bytes = Buffer.from(canonical, 'utf8');
    const selected = selectUtf8(bytes, input.cursor, input.maxBytes);
    return Object.freeze({
      effectId: record.effectId,
      toolCallId: record.toolCallId,
      status: record.status,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      totalBytes: bytes.byteLength,
      cursor: selected.cursor,
      nextCursor: selected.nextCursor,
      content: selected.content,
      complete: selected.nextCursor >= bytes.byteLength,
      workspaceId: record.workspaceId,
      tool: { ...record.tool }
    });
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
