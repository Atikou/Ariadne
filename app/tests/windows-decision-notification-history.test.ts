import { describe, expect, it, vi } from 'vitest';
import { removeDecisionNotificationHistory } from '../src/main/services/windows-decision-notification-history';
import { decisionNotificationTag } from '../src/main/services/decision-notification-activation';

const reference = { decisionId: 'decision-1', sessionId: 'session-1', runId: 'run-1', version: 1 };
describe('Windows owned notification history', () => {
  it.runIf(process.platform === 'win32')('uses fixed WinRT removal with validated tags and bounded hidden process', async () => {
    const execute = vi.fn(async (encodedScript: string) => {
      const script = Buffer.from(encodedScript, 'base64').toString('utf16le');
      expect(script).toContain("$history.Remove([string]$tag,'ariadne.decide','com.ariadne.desktop')");
      expect(script).not.toMatch(/Clear\(|RemoveGroup\(|GetHistory\(/);
      const data = /FromBase64String\('([^']+)'\)/u.exec(script)![1]!;
      expect(JSON.parse(Buffer.from(data, 'base64').toString('utf8'))).toEqual([decisionNotificationTag(reference)]);
      return 'ariadne-notification-history-removed';
    });
    expect(await removeDecisionNotificationHistory([reference], execute)).toBe(true);
  });
  it.runIf(process.platform === 'win32')('keeps unavailable OS removal unconfirmed and refuses oversized or invalid input before starting', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const execute = vi.fn(async (_encodedScript: string): Promise<string | null> => null);
      expect(await removeDecisionNotificationHistory([reference], execute)).toBe(false);
      const calls = execute.mock.calls.length;
      await expect(removeDecisionNotificationHistory(Array.from({ length: 65 }, () => reference), execute)).rejects.toThrow('batch_exceeded');
      await expect(removeDecisionNotificationHistory([{ ...reference, decisionId: "'; bad command" }], execute)).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(calls);
    } finally { log.mockRestore(); }
  });
});
