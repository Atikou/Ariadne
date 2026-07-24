import type { SandboxAuditSink } from "../sandbox/SandboxAudit.js";
import { writeStandaloneTraceEvent } from "../trace/StandaloneTraceWriter.js";

export function createSandboxMaintenanceAuditSink(tracesDir: string): SandboxAuditSink {
  return (event) => {
    writeStandaloneTraceEvent(tracesDir, event);
  };
}
