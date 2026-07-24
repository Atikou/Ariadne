import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeContext } from '../src/application/createRuntimeContext.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime workspace access ceiling', () => {
  it('keeps the configured tool catalog while enforcing read-only access per workspace', async () => {
    const dataRoot = temporaryRoot('ariadne-access-data-');
    const workspaceRoot = temporaryRoot('ariadne-access-workspace-');
    const app = createRuntimeContext(bootstrap(dataRoot, workspaceRoot, 'read'));
    expect(app.config.security?.permissions?.allowed).toEqual(['read', 'write', 'shell', 'network', 'dangerous']);
    await app.shutdown();
  });

  it('does not globally downgrade writable workspaces when another workspace is read-only', async () => {
    const dataRoot = temporaryRoot('ariadne-access-data-');
    const writableRoot = temporaryRoot('ariadne-access-writable-');
    const readOnlyRoot = temporaryRoot('ariadne-access-readonly-');
    const input = bootstrap(dataRoot, writableRoot, 'write');
    input.workspaces.push({
      workspaceId: 'read-only',
      label: 'Read-only workspace',
      rootPath: readOnlyRoot,
      access: 'read'
    });

    const app = createRuntimeContext(input);

    expect(app.config.security?.permissions?.allowed).toEqual(['read', 'write', 'shell', 'network', 'dangerous']);
    expect(app.config.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary', root: writableRoot }),
      expect.objectContaining({ id: 'read-only', root: readOnlyRoot })
    ]));
    await app.shutdown();
  });

  it('preserves the configured permission ceiling for writable workspaces', async () => {
    const dataRoot = temporaryRoot('ariadne-access-data-');
    const workspaceRoot = temporaryRoot('ariadne-access-workspace-');
    const app = createRuntimeContext(bootstrap(dataRoot, workspaceRoot, 'write'));
    expect(app.config.security?.permissions?.allowed).toEqual(['read', 'write', 'shell', 'network', 'dangerous']);
    await app.shutdown();
  });

  it('applies a full-access desktop profile to the sandbox and policy ceilings', async () => {
    const dataRoot = temporaryRoot('ariadne-access-data-');
    const workspaceRoot = temporaryRoot('ariadne-access-workspace-');
    const input = bootstrap(dataRoot, workspaceRoot, 'write');
    input.agentPermissions = {
      approvalPolicy: 'full-access',
      proposalApproval: 'automatic',
      permissionPolicy: 'autoRun',
      sandboxMode: 'danger-full-access',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    };
    const app = createRuntimeContext(input);
    expect(app.config.security?.sandbox.mode).toBe('danger-full-access');
    expect(app.config.security?.shell).toEqual({ denyCommands: [], allowCommands: [] });
    expect(app.config.security?.network).toEqual({ denyDomains: [], allowDomains: [] });
    await app.shutdown();
  });
});

function bootstrap(
  dataRoot: string,
  workspaceRoot: string,
  access: 'read' | 'write'
): RuntimeBootstrap {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: 'test',
    runtimeVersion: 'test',
    installRoot: packageRoot,
    dataRoot,
    modelRoots: [],
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'default',
    workspaces: [{ workspaceId: 'primary', label: 'Workspace', rootPath: workspaceRoot, access }],
    production: false
  };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
