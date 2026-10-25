import { describe, expect, it } from 'vitest';
import { parseDecisionNotificationActivation, windowsDecisionNotificationOptions } from '../src/main/services/decision-notification-activation';

const reference = { decisionId: 'decision-cold', sessionId: 'session-cold', runId: 'run-cold', version: 1 };
const launch = (value: unknown) => 'ariadne-decision:v1:' + Buffer.from(JSON.stringify(value)).toString('base64url');
describe('Windows Decision navigation launch data', () => {
  it('round-trips only minimal identity, uses stable bounded OS tags and escapes XML', () => {
    const options = windowsDecisionNotificationOptions({ title: '<confirm> & "review"', body: '正文\u0000', navigation: reference });
    expect(options.toastXml).toContain('&lt;confirm&gt; &amp; &quot;review&quot;');
    expect(options.toastXml).not.toContain('\u0000');
    expect(options.id).toHaveLength(16);
    expect(windowsDecisionNotificationOptions({ title: 'next', body: 'next', navigation: { ...reference, version: 2 } }).id).toBe(options.id);
    const argumentsValue = options.toastXml!.match(/launch="([^"]+)"/)![1]!;
    expect(parseDecisionNotificationActivation({ type: 'click', arguments: argumentsValue })).toEqual(reference);
  });
  it('rejects actions, replies, malformed encodings, extra fields and invalid versions', () => {
    for (const details of [{ type: 'action', arguments: launch(reference) }, { type: 'reply', arguments: launch(reference) },
      { type: 'click', arguments: launch({ ...reference, actionToken: 'forged' }) },
      { type: 'click', arguments: launch({ ...reference, version: 0 }) },
      { type: 'click', arguments: launch(reference) + '=' }, { type: 'click', arguments: 'x'.repeat(2_049) }]) {
      expect(parseDecisionNotificationActivation(details)).toBeNull();
    }
  });
  it('keeps the notification self-test independent of Decision launch data', () => {
    expect(windowsDecisionNotificationOptions({ title: 'test', body: 'test' })).toEqual({ title: 'test', body: 'test' });
  });
});
