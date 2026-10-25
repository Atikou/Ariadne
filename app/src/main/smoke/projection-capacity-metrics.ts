import { performance } from 'node:perf_hooks';
import { RuntimeSupervisor } from '../runtime/runtime-supervisor';

interface QueryMetric {
  count: number; failures: number; responseBytesMax: number;
  durationMsTotal: number; durationMsMax: number;
}
const metrics = new Map<string, QueryMetric>();
const lifecycle: { elapsedMs: number; availability: string; handshakeTimedOut: boolean }[] = [];
let installed = false;
let installedAt = 0;

/** Smoke-only metadata observer. It neither retains DTOs nor changes delivery. */
export function installProjectionCapacityMetrics(): void {
  if (installed) throw new Error('capacity_metrics_already_installed');
  installed = true;
  installedAt = performance.now();
  const onStatus = RuntimeSupervisor.prototype.onStatus;
  RuntimeSupervisor.prototype.onStatus = function (listener) {
    return onStatus.call(this, status => {
      const handshakeTimedOut = status.detail?.includes('Runtime handshake timed out;') ?? false;
      const previous = lifecycle.at(-1);
      if (previous?.availability !== status.availability || previous.handshakeTimedOut !== handshakeTimedOut) {
        if (lifecycle.length >= 128) lifecycle.shift();
        lifecycle.push({ elapsedMs: performance.now() - installedAt, availability: status.availability, handshakeTimedOut });
      }
      listener(status);
    });
  };
  const request = RuntimeSupervisor.prototype.request;
  RuntimeSupervisor.prototype.request = async function (command, options) {
    const start = performance.now();
    const metric = metrics.get(command.kind) ?? { count: 0, failures: 0,
      responseBytesMax: 0, durationMsTotal: 0, durationMsMax: 0 };
    metrics.set(command.kind, metric); metric.count++;
    try {
      const result = await request.call(this, command, options);
      metric.responseBytesMax = Math.max(metric.responseBytesMax, Buffer.byteLength(JSON.stringify(result)));
      return result;
    } catch (error) { metric.failures++; throw error; }
    finally {
      const elapsed = performance.now() - start;
      metric.durationMsTotal += elapsed;
      metric.durationMsMax = Math.max(metric.durationMsMax, elapsed);
    }
  };
}

export function projectionCapacityMetrics(): Record<string, QueryMetric> {
  return Object.fromEntries([...metrics].map(([kind, metric]) => [kind, { ...metric }]));
}

export function projectionCapacityStartupElapsedMs(): number { return performance.now() - installedAt; }
export function projectionCapacityLifecycle() { return lifecycle.map(value => ({ ...value })); }
