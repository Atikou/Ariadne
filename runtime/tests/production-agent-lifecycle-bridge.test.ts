import { describe, expect, it, vi } from 'vitest';

import { ConfiguredAgentLifecycleHooks } from '../src/composition/ConfiguredAgentLifecycleHooks.js';
import { ProductionAgentLifecycleBridge } from '../src/composition/ProductionAgentLifecycleBridge.js';

describe('ProductionAgentLifecycleBridge process resource cleanup', () => {
  it('closes only the terminal Run owner after the durable terminal observation', async () => {
    const closeOwner = vi.fn(async () => undefined);
    const bridge = new ProductionAgentLifecycleBridge(
      new ConfiguredAgentLifecycleHooks([]),
      { closeOwner }
    );

    bridge.observe({
      event: 'turn.commit.post',
      eventId: 'turn-1',
      runId: 'run-live',
      occurredAt: '2026-08-26T00:00:00.000Z',
      outcome: 'continued',
      terminal: false
    });
    expect(closeOwner).not.toHaveBeenCalled();

    bridge.observe({
      event: 'turn.commit.post',
      eventId: 'turn-2',
      runId: 'run-live',
      occurredAt: '2026-08-26T00:00:01.000Z',
      outcome: 'completed',
      terminal: true
    });
    await Promise.resolve();
    expect(closeOwner).toHaveBeenCalledOnce();
    expect(closeOwner).toHaveBeenCalledWith('run-live');
  });
});
