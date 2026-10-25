import { createRuntimeKernelApplicationFactory } from '../application/RuntimeKernelApplication.js';
import { createNodeIpcRuntimeHost } from '../composition/createNodeIpcRuntimeHost.js';
import { createAgentProcessSandboxFactory } from './createAgentProcessSandboxFactory.js';
import { createCapacityStartupTrace } from './CapacityStartupTrace.js';

createNodeIpcRuntimeHost(
  createRuntimeKernelApplicationFactory(),
  createAgentProcessSandboxFactory(),
  createCapacityStartupTrace()
).start();
