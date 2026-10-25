import { describe, expect, it, vi } from 'vitest';
import { DraftQuitBlockedError, flushRendererDraftsBeforeQuit } from '../src/main/services/renderer-draft-quit';
describe('draft-safe desktop quit', () => {
  it('awaits privileged window persistence before allowing irreversible cleanup', async () => {
    let release!: () => void;
    const executeJavaScript = vi.fn((_code: string) => new Promise(resolve => { release = () => resolve(true); }));
    let complete = false;
    const pending = flushRendererDraftsBeforeQuit([{ isDestroyed: () => false, executeJavaScript }]).then(() => { complete = true; });
    expect(complete).toBe(false); expect(executeJavaScript.mock.calls[0]![0]).toContain('flushAndClose');
    release(); await pending; expect(complete).toBe(true);
  });
  it('blocks failed persistence and resumes editing instead of destroying the window', async () => {
    const executeJavaScript = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce(undefined);
    await expect(flushRendererDraftsBeforeQuit([{ isDestroyed: () => false, executeJavaScript }])).rejects.toBeInstanceOf(DraftQuitBlockedError);
    expect(executeJavaScript.mock.calls[1]![0]).toContain('resumeAfterCancelledQuit');
  });
  it('bounds an unresponsive window without pretending it saved', async () => {
    const executeJavaScript = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValueOnce(undefined);
    await expect(flushRendererDraftsBeforeQuit([{ isDestroyed: () => false, executeJavaScript }], 10)).rejects.toThrow('chat_draft_quit_blocked');
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });
});
