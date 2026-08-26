import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  assertPublicProjectionReadBatchV3,
  assertPublicProjectionSnapshotV3,
  type PublicProjectionReadBatchV3,
  type PublicProjectionReadRequestV3,
  type PublicProjectionSnapshotV3
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import { unwrapPublicResult } from '../public-result';

export class ProjectionReadResetSignal extends Error {
  constructor(readonly reason: 'stream_mismatch' | 'contract_mismatch' | 'cursor_gap' | 'history_mismatch') {
    super(`projection_read_reset_required:${reason}`);
    this.name = 'ProjectionReadResetSignal';
  }
}

export class ProjectionProtocolIntegrityError extends Error {
  constructor(readonly integrityCode: string) {
    super(`projection_protocol_integrity_error:${integrityCode}`);
    this.name = 'ProjectionProtocolIntegrityError';
  }
}

export class ProjectionRuntimeClient {
  constructor(private readonly api: AriadneApi['runtime']) {}

  async getSnapshot(): Promise<PublicProjectionSnapshotV3> {
    const result = unwrapPublicResult(await this.api.request({
      kind: 'projection.snapshot.get',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
    }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.snapshot') {
      throw new Error(`projection_snapshot_result_invalid:${result.kind}`);
    }
    try {
      return assertPublicProjectionSnapshotV3(result.snapshot);
    } catch (error) {
      throw new ProjectionProtocolIntegrityError(errorCode(error));
    }
  }

  async readCommits(
    request: PublicProjectionReadRequestV3
  ): Promise<PublicProjectionReadBatchV3> {
    const result = unwrapPublicResult(await this.api.request({
      kind: 'projection.commits.read',
      request
    }, { commandId: crypto.randomUUID() }));
    if (result.kind !== 'projection.commits') {
      throw new Error(`projection_commits_result_invalid:${result.kind}`);
    }
    try {
      return assertPublicProjectionReadBatchV3(result.batch);
    } catch (error) {
      const reason = classifyRecoverableReadMismatch(result.batch, request);
      if (reason !== null) throw new ProjectionReadResetSignal(reason);
      throw new ProjectionProtocolIntegrityError(errorCode(error));
    }
  }
}

function classifyRecoverableReadMismatch(
  value: unknown,
  request: PublicProjectionReadRequestV3
): ProjectionReadResetSignal['reason'] | null {
  if (!isRecord(value)) return null;
  if (value.contractVersion !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
    return 'contract_mismatch';
  }
  if (value.streamId !== request.streamId) return 'stream_mismatch';
  if (value.status !== 'ok') return null;
  if (value.afterCursor !== request.afterCursor) return 'cursor_gap';
  if (value.afterDigest !== request.afterDigest) return 'history_mismatch';
  if (!Array.isArray(value.commits)) return null;
  let expectedCursor = request.afterCursor + 1;
  let expectedDigest = request.afterDigest;
  for (const candidate of value.commits) {
    if (!isRecord(candidate) || candidate.cursor !== expectedCursor) return 'cursor_gap';
    if (typeof candidate.cursorDigest !== 'string') return null;
    expectedCursor += 1;
    expectedDigest = candidate.cursorDigest;
  }
  if (value.nextCursor !== expectedCursor - 1) return 'cursor_gap';
  if (value.nextDigest !== expectedDigest) return 'history_mismatch';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 512) || 'unknown';
}
