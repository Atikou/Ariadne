import { createRuntimeKernelApplicationFactory } from '../application/RuntimeKernelApplication.js';
import { createNodeIpcRuntimeHost } from '../composition/createNodeIpcRuntimeHost.js';
import { createAgentProcessSandboxFactory } from './createAgentProcessSandboxFactory.js';

createNodeIpcRuntimeHost(
  createRuntimeKernelApplicationFactory(),
  createAgentProcessSandboxFactory()
).start();
