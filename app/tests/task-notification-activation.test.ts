import { describe, expect, it } from 'vitest';
import { parseTaskNotificationActivation, windowsTaskNotificationOptions } from '../src/main/services/task-notification-activation';

const reference = { runId: 'run-a', workspaceId: 'workspace-a', sessionId: 'session-a', version: 8,
  state: 'completed' as const, sourceStatus: 'completed' };
describe('untrusted Windows terminal task activation', () => {
  it('round-trips only task identity with an escaped toast and bounded distinct group/tag', () => {
    const content = windowsTaskNotificationOptions({ title: '<complete>', body: '&result', taskNavigation: reference });
    expect(content.groupId).toBe('ariadne.task'); expect(content.id).toHaveLength(16);
    expect(content.toastXml).toContain('&lt;complete&gt;');
    expect(parseTaskNotificationActivation({ type: 'click', arguments: content.toastXml!.match(/launch="([^"]+)"/)![1]! })).toEqual(reference);
  });
  it('rejects action payloads, extras, padded/noncanonical encodings and nonterminal states', () => {
    const launch = (value: unknown) => 'ariadne-task:v1:' + Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const details of [{ type: 'action', arguments: launch(reference) }, { type: 'click', arguments: launch({ ...reference, command: 'retry' }) },
      { type: 'click', arguments: launch({ ...reference, state: 'running' }) }, { type: 'click', arguments: launch(reference) + '=' }])
      expect(parseTaskNotificationActivation(details)).toBeNull();
  });
});
