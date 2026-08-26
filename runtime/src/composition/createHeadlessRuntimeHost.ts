import type { RuntimeApplicationFactory } from '../ingress/RuntimeApplication.js';
import {
  HeadlessRuntimeHost,
  type HeadlessRuntimeHostOptions
} from '../transport/HeadlessRuntimeHost.js';
import { createComposedRuntimeIngress } from './createComposedRuntimeIngress.js';
import type { AgentProcessSandboxFactory } from '../control/ports/AgentProcessSandbox.js';

export function createHeadlessRuntimeHost(
  runtimeApplicationFactory: RuntimeApplicationFactory,
  options: HeadlessRuntimeHostOptions = {},
  processSandboxFactory?: AgentProcessSandboxFactory
): HeadlessRuntimeHost {
  // Headless callers historically supply their own bootstrap fingerprint.
  // Preserve that protocol behavior while retaining every storage preflight,
  // owner fence and lifecycle boundary from the shared composition.
  return new HeadlessRuntimeHost(
    createComposedRuntimeIngress(
      runtimeApplicationFactory,
      {
        validateBuildIdentity: false,
        ...(processSandboxFactory === undefined ? {} : { processSandboxFactory })
      }
    ),
    options
  );
}
