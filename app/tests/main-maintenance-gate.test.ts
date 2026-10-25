import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { MainMaintenanceGate, type MainMaintenanceCapture } from '../src/main/data-management/main-maintenance-gate';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('Main maintenance write admission', () => {
  it('drains accepted work before final shutdown, admits original final facts and permanently closes new writes', async () => {
    const gate = new MainMaintenanceGate(), accepted = deferred(), release = deferred(), shuttingDown = deferred(), finish = deferred();
    const previous = gate.write(async () => { accepted.resolve(); await release.promise; await gate.write(() => undefined); });
    await accepted.promise;
    const stop = gate.withOwnerShutdown(async () => {
      await gate.write(() => undefined); shuttingDown.resolve(); await finish.promise;
    });
    await expect(gate.write(() => undefined)).rejects.toThrow('main_data_maintenance');
    const fact = gate.writeDeferred(() => 'pty_exit');
    release.resolve(); await previous; await shuttingDown.promise;
    await expect(fact).resolves.toBe('pty_exit');
    await expect(gate.write(() => undefined)).rejects.toThrow('main_data_maintenance');
    finish.resolve(); await stop;
    await expect(gate.writeDeferred(() => undefined)).rejects.toThrow('main_data_owners_closed');
    await expect(gate.write(() => undefined)).rejects.toThrow('main_data_maintenance');
  });

  it('reopens source admission after a failed shutdown and expires its administrative async context', async () => {
    const gate = new MainMaintenanceGate(), late = deferred(); let background!: Promise<unknown>;
    await expect(gate.withOwnerShutdown(async () => {
      background = (async () => { await late.promise; return gate.write(() => undefined); })();
      throw new Error('shutdown_unconfirmed');
    })).rejects.toThrow('shutdown_unconfirmed');
    expect(gate.busy).toBe(false);
    await gate.withMaintenance(async boundary => {
      await boundary.capture(async () => {
        late.resolve(); await expect(background).rejects.toThrow('main_data_maintenance');
      });
    });
  });
  it('retains the freeze until an invoked capture settles and expires capabilities between maintenance operations', async () => {
    const gate = new MainMaintenanceGate(), entered = deferred(), release = deferred();
    let previous!: MainMaintenanceCapture;
    const maintenance = gate.withMaintenance(async boundary => {
      previous = boundary;
      void boundary.capture(async () => { entered.resolve(); await release.promise; });
      return 'coordinator_finished';
    });
    await entered.promise;
    expect(gate.busy).toBe(true);
    await expect(gate.write(() => undefined)).rejects.toThrow('main_data_maintenance');
    release.resolve(); await expect(maintenance).resolves.toBe('coordinator_finished');
    await gate.withMaintenance(async boundary => {
      await expect(previous.capture(async () => undefined)).rejects.toThrow('main_maintenance_capture_invalid');
      await boundary.capture(async () => undefined);
    });
    expect(gate.busy).toBe(false);
  });

  it('waits for a running capture even when the coordinator fails', async () => {
    const gate = new MainMaintenanceGate(), entered = deferred(), release = deferred();
    const maintenance = gate.withMaintenance(async boundary => {
      void boundary.capture(async () => { entered.resolve(); await release.promise; });
      throw new Error('coordinator_failed');
    });
    const result = expect(maintenance).rejects.toThrow('coordinator_failed');
    await entered.promise; expect(gate.busy).toBe(true);
    release.resolve(); await result; expect(gate.busy).toBe(false);
  });
  it('lets previously admitted operations finish nested writes while denying later writes and captures only after all settle', async () => {
    const gate = new MainMaintenanceGate(), release = deferred(), captured = deferred(); const trace: string[] = [];
    const pending = gate.write(async () => {
      await release.promise;
      await gate.write(() => { trace.push('accepted_nested_commit'); });
    });
    const maintenance = gate.withMaintenance(async boundary => boundary.capture(async () => {
      trace.push('snapshot'); captured.resolve(); return 'published';
    }));
    expect(gate.busy).toBe(true);
    await expect(gate.write(() => trace.push('late_write'))).rejects.toThrow('main_data_maintenance');
    expect(trace).toEqual([]);
    release.resolve(); await pending; await captured.promise;
    await expect(maintenance).resolves.toBe('published');
    expect(trace).toEqual(['accepted_nested_commit', 'snapshot']); expect(gate.busy).toBe(false);
    await gate.write(() => trace.push('resumed_write'));
    expect(trace.at(-1)).toBe('resumed_write');
  });

  it('an expired async-context ticket cannot let a delayed callback write during a frozen snapshot', async () => {
    const gate = new MainMaintenanceGate(), release = deferred(), entered = deferred(); let late!: () => Promise<void>;
    await gate.write(() => { late = AsyncLocalStorage.bind(async () => { await gate.write(() => undefined); }); });
    const maintenance = gate.withMaintenance(boundary => boundary.capture(async () => { entered.resolve(); await release.promise; }));
    await entered.promise;
    await expect(late()).rejects.toThrow('main_data_maintenance');
    release.resolve(); await maintenance;
    expect(gate.busy).toBe(false);
  });

  it('does not replay a failed capture, prevents self-deadlock and releases admission after cancellation during drain', async () => {
    const gate = new MainMaintenanceGate(); let attempts = 0;
    await expect(gate.withMaintenance(boundary => boundary.capture(async () => { attempts++; throw new Error('destination_full'); })))
      .rejects.toThrow('destination_full');
    expect(attempts).toBe(1); expect(gate.busy).toBe(false);
    await expect(gate.write(() => gate.withMaintenance(async () => undefined))).rejects.toThrow('main_maintenance_from_active_writer');
    const release = deferred(), controller = new AbortController();
    const write = gate.write(() => release.promise);
    const maintenance = gate.withMaintenance(boundary => boundary.capture(async () => { attempts++; }, controller.signal));
    controller.abort(); await expect(maintenance).rejects.toThrow('main_maintenance_cancelled');
    expect(attempts).toBe(1); expect(gate.busy).toBe(false);
    release.resolve(); await write;
  });
});
