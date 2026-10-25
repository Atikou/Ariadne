import { describe, expect, it } from 'vitest';
import { assertValidProjectionCommit } from '../src/projection/PublicProjectionContract.js';
import { assertStoredProjectionCommit } from '../src/adapters/persistence/StoredProjectionRecords.js';

function fixture() {
  const at = '2032-01-01T00:00:00.000Z';
  return { contractVersion: '5.0', eventId: 'owned-event', sourceId: 'owned-source', sourceCursor: 1,
    occurredAt: at, changes: [{ feature: 'messages', operation: 'upsert', aggregateId: 'owned-message',
      aggregateVersion: 1, projectedAt: at, dto: { messageId: 'owned-message', sessionId: 'owned-session',
        version: 1, role: 'assistant', content: '原始正文', status: 'completed', createdAt: at, updatedAt: at } }] };
}

describe('owned immutable projection commit validation', () => {
  it('shares the validated identity through admission and final ledger while protecting every nested field', () => {
    const commit = assertValidProjectionCommit(fixture());
    expect(assertValidProjectionCommit(commit)).toBe(commit);
    expect(assertStoredProjectionCommit(commit)).toBe(commit);
    expect(() => { commit.sourceCursor = 2; }).toThrow(TypeError);
    expect(() => { commit.changes.pop(); }).toThrow(TypeError);
    const change = commit.changes[0]!;
    expect(() => { change.aggregateVersion = 2; }).toThrow(TypeError);
    if (change.feature !== 'messages' || change.dto === null) throw new Error('fixture');
    expect(() => { change.dto!.content = '修改正文'; }).toThrow(TypeError);
  });

  it('does not freeze or keep mutable aliases to caller input', () => {
    const raw = fixture(), commit = assertValidProjectionCommit(raw);
    raw.sourceCursor = 2;
    raw.changes[0]!.dto.content = '调用方的新正文';
    expect(Object.isFrozen(raw)).toBe(false);
    expect(commit.sourceCursor).toBe(1);
    expect(commit.changes[0]!.dto).toMatchObject({ content: '原始正文' });
    expect(assertValidProjectionCommit(raw)).not.toBe(commit);
  });

  it('validates unowned frozen objects and copies rather than treating freezing as proof', () => {
    const invalid = Object.freeze({ ...fixture(), sourceCursor: 0 });
    expect(() => assertValidProjectionCommit(invalid)).toThrow();
    const commit = assertValidProjectionCommit(fixture());
    const copy = JSON.parse(JSON.stringify(commit));
    copy.changes[0].dto.content = 'Bearer abcdefghijklmnopqrstuvwxyz';
    expect(() => assertStoredProjectionCommit(copy)).toThrow();
    expect(assertStoredProjectionCommit(commit)).toBe(commit);
  });
});
