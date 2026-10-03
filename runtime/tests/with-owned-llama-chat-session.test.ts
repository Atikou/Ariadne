import { describe, expect, it, vi } from 'vitest';

import { withOwnedLlamaChatSession } from '../src/model/local/withOwnedLlamaChatSession.js';

describe('withOwnedLlamaChatSession', () => {
  it('waits for asynchronous sequence acquisition and releases the owned sequence', async () => {
    const sequence = { dispose: vi.fn() };
    const session = { dispose: vi.fn() };
    let release!: () => void;
    const acquired = new Promise<typeof sequence>((resolve) => {
      release = () => resolve(sequence);
    });
    const operation = withOwnedLlamaChatSession(
      () => acquired,
      (owned) => {
        expect(owned).toBe(sequence);
        return session;
      },
      async () => 'completed'
    );

    expect(session.dispose).not.toHaveBeenCalled();
    release();

    await expect(operation).resolves.toBe('completed');
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledWith({ disposeSequence: true });
    expect(sequence.dispose).not.toHaveBeenCalled();
  });
});
