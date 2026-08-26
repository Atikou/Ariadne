import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
  FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
  FIRST_PARTY_AGENT_TOOL_NAMES,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import {
  createDefaultRuntimePolicySnapshot,
  type RuntimePolicySnapshot
} from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compileProductionRuntimeCapabilityManifest
} from '../src/composition/ProductionRuntimeCapabilityManifest.js';
import type { HostCapabilityClient } from '../src/ingress/HostCapabilityClient.js';
import type { FirstPartyProcessSandboxFactory } from '../src/composition/first-party-tools/FirstPartyAgentToolSupport.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('first-party Agent Tool Catalog', () => {
  it('executes workspace commands only through the injected process sandbox', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-command-workspace-'));
    temporaryRoots.push(root);
    const runFile = vi.fn(async () => ({
      executionId: 'execution-command',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      truncated: false,
      spawnFailed: false,
      isolation: {
        backend: 'windows-native' as const,
        enforced: true,
        mode: 'workspace-write' as const,
        networkMode: 'offline' as const,
        account: 'offline' as const,
        restrictedToken: true,
        filesystemAcl: true,
        appContainer: true,
        filesystemReadRestricted: true,
        credentialIsolation: true,
        publicObjectWriteRestricted: true,
        firewall: true,
        jobObject: true,
        privateDesktop: true,
        environment: 'allowlist' as const,
        processTreeTermination: true
      }
    }));
    const sandbox = {
      mode: 'workspace-write' as const,
      runFile,
      openFileLease: vi.fn()
    };
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-command',
      label: 'Command workspace',
      rootPath: root,
      access: 'write'
    }], undefined, [], () => sandbox);
    const command = catalog.entries.find(
      (entry) => entry.document.toolName === 'workspace.run_command'
    );

    await expect(command?.executable.execute({
      command: 'git.exe',
      args: ['status']
    }, {
      runId: 'run-command',
      effectId: 'effect-command',
      toolCallId: 'call-command',
      idempotencyKey: 'idempotency-command',
      capabilityIds: ['workspace.shell'],
      scope: ['workspace-command'],
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        exitCode: 0,
        stdout: 'ok',
        isolation: { backend: 'windows-native', enforced: true }
      }
    });
    expect(runFile).toHaveBeenCalledWith(expect.objectContaining({
      file: 'git.exe',
      args: ['status'],
      cwd: expect.any(String),
      workspaceRoot: root,
      networkMode: 'offline'
    }));
    expect(realpathSync.native(runFile.mock.calls[0]![0].cwd))
      .toBe(realpathSync.native(root));
  });

  it('keeps browser read tools in the same immutable production catalog', async () => {
    const request = vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example'
    }));
    const catalog = await compileCapabilityCatalog([], { request });

    expect(catalog.revision).toBe(FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION);
    expect(catalog.catalogDigest).toBe(FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST);
    expect(catalog.entries.map((entry) => entry.document.toolName)).toEqual(
      [...FIRST_PARTY_AGENT_TOOL_NAMES]
    );
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.run_command')
      ?.document.lifecycleSemantics).toBe('bounded_invocation');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.process_start')
      ?.document.lifecycleSemantics).toBe('resource_create');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.process_read')
      ?.document.lifecycleSemantics).toBe('resource_observe');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.process_write')
      ?.document.lifecycleSemantics).toBe('resource_mutate');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.process_stop')
      ?.document.lifecycleSemantics).toBe('resource_close');

    const navigate = catalog.entries.find(
      (entry) => entry.document.toolName === 'browser.navigate'
    );
    expect(navigate?.executable.normalizeAndValidate({
      url: 'http://not-authorized.example'
    })).toEqual({ status: 'rejected' });
    const result = await navigate?.executable.execute({
      url: 'https://example.com/'
    }, {
      runId: 'run-browser',
      effectId: 'effect-browser',
      toolCallId: 'call-browser',
      idempotencyKey: 'idempotency-browser',
      capabilityIds: ['browser.use'],
      scope: ['workspace-browser'],
      signal: new AbortController().signal
    });
    expect(result).toEqual({
      status: 'succeeded',
      result: { url: 'https://example.com/', title: 'Example' }
    });
    expect(request).toHaveBeenCalledWith({
      kind: 'browser.navigate',
      url: 'https://example.com/'
    }, 30_000);
  });

  it('exposes bounded browser interaction tools with explicit approval', async () => {
    const request = vi.fn(async (operation: { kind: string }) => ({
      operation: operation.kind,
      ok: true
    }));
    const catalog = await compileCapabilityCatalog([], { request });
    const byName = (name: string) => catalog.entries.find(
      (entry) => entry.document.toolName === name
    );
    const click = byName('browser.click');
    const type = byName('browser.type');
    const scroll = byName('browser.scroll');

    expect(click?.document.permission.approval).toBe('required');
    expect(type?.document.permission.approval).toBe('required');
    expect(scroll?.document.permission.approval).toBe('never');
    expect(click?.executable.normalizeAndValidate({ selector: '' })).toEqual({
      status: 'rejected'
    });
    expect(type?.executable.normalizeAndValidate({
      selector: '#query',
      text: 'Ariadne'
    })).toEqual({
      status: 'accepted',
      input: { selector: '#query', text: 'Ariadne', sensitive: false }
    });
    expect(scroll?.executable.normalizeAndValidate({ deltaY: 500 })).toEqual({
      status: 'accepted',
      input: { deltaX: 0, deltaY: 500 }
    });

    const result = await click?.executable.execute({ selector: '#submit' }, {
      runId: 'run-browser-click',
      effectId: 'effect-browser-click',
      toolCallId: 'call-browser-click',
      idempotencyKey: 'idempotency-browser-click',
      capabilityIds: ['browser.use'],
      scope: ['workspace-browser'],
      signal: new AbortController().signal
    });
    expect(result).toEqual({
      status: 'succeeded',
      result: { operation: 'browser.click', ok: true }
    });
    expect(request).toHaveBeenCalledWith({
      kind: 'browser.click',
      selector: '#submit'
    }, 30_000);
  });

  it('persists screenshot and download bytes only inside an approved workspace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-browser-artifact-'));
    temporaryRoots.push(root);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const request = vi.fn(async (operation: { kind: string }) => ({
      name: operation.kind === 'browser.screenshot' ? 'capture.png' : 'asset.bin',
      mediaType: operation.kind === 'browser.screenshot'
        ? 'image/png'
        : 'application/octet-stream',
      dataBase64: png.toString('base64')
    }));
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-artifact',
      label: 'Artifact workspace',
      rootPath: root,
      access: 'write'
    }], { request });
    const context = {
      runId: 'run-browser-artifact',
      effectId: 'effect-browser-artifact',
      toolCallId: 'call-browser-artifact',
      idempotencyKey: 'idempotency-browser-artifact',
      capabilityIds: ['browser.use', 'workspace.write'],
      scope: ['workspace-artifact'],
      signal: new AbortController().signal
    };
    const screenshot = catalog.entries.find(
      (entry) => entry.document.toolName === 'browser.screenshot'
    );
    const download = catalog.entries.find(
      (entry) => entry.document.toolName === 'browser.download'
    );

    expect(await screenshot?.executable.execute({ path: 'artifacts/page.png' }, context))
      .toEqual({
        status: 'succeeded',
        result: {
          path: 'artifacts/page.png',
          mediaType: 'image/png',
          byteLength: png.byteLength,
          sourceName: 'capture.png'
        }
      });
    expect(readFileSync(path.join(root, 'artifacts', 'page.png'))).toEqual(png);
    expect(await download?.executable.execute({
      url: 'https://example.com/asset.bin',
      path: 'downloads/asset.bin'
    }, context)).toEqual({
      status: 'succeeded',
      result: {
        path: 'downloads/asset.bin',
        mediaType: 'application/octet-stream',
        byteLength: png.byteLength,
        sourceName: 'asset.bin'
      }
    });
    expect(readFileSync(path.join(root, 'downloads', 'asset.bin'))).toEqual(png);
    expect(download?.executable.normalizeAndValidate({
      url: 'http://example.com/asset.bin',
      path: 'asset.bin'
    })).toEqual({ status: 'rejected' });
  });

  it('exposes configured remote MCP servers without exposing endpoints or credentials', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-workspace-'));
    temporaryRoots.push(root);
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-mcp',
      label: 'MCP workspace',
      rootPath: root,
      access: 'read'
    }], { request: vi.fn() }, [{
      id: 'docs',
      enabled: true,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/',
      credentialRef: 'vault:docs'
    }, {
      id: 'disabled',
      enabled: false,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://disabled.example.com/'
    }]);
    const listServers = catalog.entries.find(
      (entry) => entry.document.toolName === 'mcp.list_servers'
    );
    const callTool = catalog.entries.find(
      (entry) => entry.document.toolName === 'mcp.call_tool'
    );
    expect(callTool?.document.permission.approval).toBe('required');
    expect(callTool?.document.resourceSemantics).toBe('external_resource_id');
    expect(await listServers?.executable.execute({}, {
      runId: 'run-mcp-list',
      effectId: 'effect-mcp-list',
      toolCallId: 'call-mcp-list',
      idempotencyKey: 'idempotency-mcp-list',
      capabilityIds: ['mcp.use'],
      scope: ['workspace-mcp'],
      signal: new AbortController().signal
    })).toEqual({
      status: 'succeeded',
      result: { servers: ['docs'] }
    });
  });
});

async function compileCapabilityCatalog(
  workspaces: RuntimeBootstrap['workspaces'],
  hostCapabilities?: HostCapabilityClient,
  mcpServers: RuntimePolicySnapshot['mcp']['servers'] = [],
  processSandboxFactory?: FirstPartyProcessSandboxFactory
) {
  const runtimePolicy = createDefaultRuntimePolicySnapshot();
  runtimePolicy.mcp.servers = [...mcpServers];
  const bootstrap: RuntimeBootstrap = {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: '00000000-0000-4000-8000-000000000071',
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: 'a'.repeat(64),
    installRoot: path.resolve('.'),
    dataRoot: path.resolve('.'),
    modelRoots: [],
    agentPermissions: {
      approvalPolicy: 'request',
      proposalApproval: 'manual',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network']
    },
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy,
    profile: 'test',
    workspaces: [...workspaces],
    production: false
  };
  const manifest = await compileProductionRuntimeCapabilityManifest({
    bootstrap,
    ...(hostCapabilities === undefined ? {} : { hostCapabilities }),
    ...(processSandboxFactory === undefined ? {} : {
      processSandboxFactory: (options) => processSandboxFactory(options.workspaceRoot)
    })
  });
  const catalog = manifest.agentToolCatalogSnapshots[0];
  if (catalog === undefined) throw new Error('test_capability_catalog_missing');
  return catalog;
}
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
