import type { RuntimeApplicationFactory } from '../ingress/RuntimeApplication.js';
import { NodeIpcRuntimeHost } from '../transport/NodeIpcRuntimeHost.js';
import { createComposedRuntimeIngress } from './createComposedRuntimeIngress.js';
import type { AgentProcessSandboxFactory } from '../control/ports/AgentProcessSandbox.js';

export function createNodeIpcRuntimeHost(
  runtimeApplicationFactory: RuntimeApplicationFactory,
  processSandboxFactory?: AgentProcessSandboxFactory
): NodeIpcRuntimeHost {
  return new NodeIpcRuntimeHost(
    createComposedRuntimeIngress(runtimeApplicationFactory, {
      ...(processSandboxFactory === undefined ? {} : { processSandboxFactory })
    })
  );
}
