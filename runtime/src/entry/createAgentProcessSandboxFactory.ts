import { SecurityConfigSchema } from '../config/types.js';
import type {
  AgentProcessSandbox,
  AgentProcessSandboxFactory
} from '../control/ports/AgentProcessSandbox.js';
import { createProcessSandbox } from '../sandbox/createProcessSandbox.js';
import { requireInteractiveProcessSandbox } from '../sandbox/ProcessSandbox.js';

/** Outer adapter: legacy native sandbox mechanics are injected into v3 ports. */
export function createAgentProcessSandboxFactory(): AgentProcessSandboxFactory {
  return (input) => {
    const security = SecurityConfigSchema.parse({
      permissions: { allowed: [...input.allowedPermissions] },
      sandbox: { mode: input.mode }
    });
    const sandbox = requireInteractiveProcessSandbox(createProcessSandbox(
      security,
      input.installRoot,
      undefined,
      { requireTrustedHelper: input.production }
    ));
    return sandbox as unknown as AgentProcessSandbox;
  };
}
