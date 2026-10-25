import { expect, it } from 'vitest';
import { searchConversations } from '../src/renderer/src/modules/chat/conversation-search';

it('bounds physical workspace queries and retained results independently of the directory page', async () => {
  let active = 0, peak = 0;
  const result = await searchConversations({ query: async workspaceId => {
    peak = Math.max(peak, ++active); await Promise.resolve(); active--;
    return Array.from({ length: 50 }, (_, index) => ({ workspaceId, sessionId: `${workspaceId}-${index}`, version: 1,
      title: 'Off-page match', status: 'active' as const, updatedAt: '2026-10-05T00:00:00.000Z', lineage: null, matches: [] }));
  } }, Array.from({ length: 12 }, (_, index) => `workspace-${index}`), 'needle', () => true);
  expect(peak).toBe(4); expect(result?.items).toHaveLength(128); expect(result?.limited).toBe(true);
});

it('stops scheduling workspace reads after the search generation changes', async () => {
  let current = true, reads = 0;
  const result = await searchConversations({ query: async () => { reads++; current = false; return []; } },
    Array.from({ length: 12 }, (_, index) => `workspace-${index}`), 'needle', () => current);
  expect(reads).toBe(4); expect(result).toBeNull();
});
