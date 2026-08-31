import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
  FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
  FIRST_PARTY_AGENT_TOOL_NAMES,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { COMPUTER_READ_SCOPE_ID } from '@ariadne/protocol/public';
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
  it('pins bounded model semantics and protected public-static presentation for every Tool', async () => {
    const catalog = await compileCapabilityCatalog([]);

    expect(catalog.revision).toBe(FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION);
    expect(catalog.entries).toHaveLength(FIRST_PARTY_AGENT_TOOL_NAMES.length);
    for (const entry of catalog.entries) {
      expect(entry.document.documentVersion).toBe(2);
      expect(entry.document.model.description.trim()).toBe(entry.document.model.description);
      expect(entry.document.model.description.length).toBeGreaterThan(0);
      expect(entry.document.model.guidance.length).toBeLessThanOrEqual(8);
      expect(entry.document.presentation.label.length).toBeGreaterThan(0);
      expect(entry.document.presentation.resultVisibility).toBe('protected');
    }
  });

  it('exposes full-computer operations as an immutable read-only tool family', async () => {
    const request = vi.fn(async (operation: { kind: string; path: string }) => ({
      operation: operation.kind,
      path: operation.path
    }));
    const catalog = await compileCapabilityCatalog([], { request });
    const byName = (name: string) => catalog.entries.find(
      (entry) => entry.document.toolName === name
    );

    for (const name of [
      'computer.list_directory',
      'computer.open_path',
      'computer.read_text_file'
    ]) {
      expect(byName(name)?.document).toMatchObject({
        capabilityIds: ['computer.read'],
        requiredWorkspaceAccess: 'read',
        permission: { approval: 'never' }
      });
    }
    expect(byName('computer.list_directory')?.document.sideEffect).toBe('read');
    expect(byName('computer.read_text_file')?.document.sideEffect).toBe('read');
    expect(byName('computer.open_path')?.document.sideEffect).toBe('external');

    await expect(byName('computer.read_text_file')?.executable.execute({
      path: 'C:\\Users\\Public\\notes.txt'
    }, {
      runId: 'run-computer-read',
      effectId: 'effect-computer-read',
      toolCallId: 'call-computer-read',
      idempotencyKey: 'idempotency-computer-read',
      capabilityIds: ['computer.read'],
      scope: [COMPUTER_READ_SCOPE_ID],
      signal: new AbortController().signal
    })).resolves.toEqual({
      status: 'succeeded',
      result: {
        operation: 'computer.read_text_file',
        path: 'C:\\Users\\Public\\notes.txt'
      }
    });
    expect(request).toHaveBeenCalledWith({
      kind: 'computer.read_text_file',
      path: 'C:\\Users\\Public\\notes.txt'
    }, 30_000);
  });

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

  it('requires an observed opaque version before replacing a workspace file', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-file-workspace-'));
    temporaryRoots.push(root);
    writeFileSync(path.join(root, 'note.txt'), 'before', 'utf8');
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-file',
      label: 'File workspace',
      rootPath: root,
      access: 'write'
    }]);
    const read = catalog.entries.find(
      (entry) => entry.document.toolName === 'workspace.read_file'
    );
    const write = catalog.entries.find(
      (entry) => entry.document.toolName === 'workspace.write_file'
    );
    expect(read?.document.toolVersion).toBe('2.0.0');
    expect(write?.document.toolVersion).toBe('2.0.0');
    expect(write?.executable.normalizeAndValidate({
      path: 'note.txt',
      content: 'blind'
    })).toEqual({ status: 'rejected' });
    expect(write?.executable.normalizeAndValidate({
      path: 'note.txt',
      content: 'missing-version',
      mode: 'replace_if_version'
    })).toEqual({ status: 'rejected' });

    const context = {
      runId: 'run-file',
      effectId: 'effect-file',
      toolCallId: 'call-file',
      idempotencyKey: 'idempotency-file',
      capabilityIds: ['workspace.read', 'workspace.write'],
      scope: ['workspace-file'],
      signal: new AbortController().signal
    };
    const observed = await read?.executable.execute({ path: 'note.txt' }, context);
    expect(observed).toMatchObject({
      status: 'succeeded',
      result: {
        path: 'note.txt',
        content: 'before',
        byteLength: 6,
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }
    });
    if (
      observed?.status !== 'succeeded'
      || typeof observed.result !== 'object'
      || observed.result === null
      || Array.isArray(observed.result)
      || typeof observed.result.version !== 'string'
    ) throw new Error('workspace_file_observation_missing');
    const observedVersion = observed.result.version;

    writeFileSync(path.join(root, 'note.txt'), 'external', 'utf8');
    await expect(write?.executable.execute({
      path: 'note.txt',
      content: 'agent',
      mode: 'replace_if_version',
      expectedVersion: observedVersion
    }, context)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'workspace_file_stale_version'
    });
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('external');

    await expect(write?.executable.execute({
      path: 'created.txt',
      content: 'created',
      mode: 'create_if_absent'
    }, context)).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        path: 'created.txt',
        operation: 'created',
        byteLength: 7,
        diff: expect.stringContaining('+created'),
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }
    });
    expect(readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('created');
  });

  it('searches and edits workspace text through one versioned file authority', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-structured-file-workspace-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'note.txt');
    writeFileSync(target, 'alpha 😀 beta\r\nneedle here\r\n', 'utf8');
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-structured-file',
      label: 'Structured file workspace',
      rootPath: root,
      access: 'write'
    }]);
    const byName = (name: string) => catalog.entries.find(
      (entry) => entry.document.toolName === name
    );
    const read = byName('workspace.read_file');
    const edit = byName('workspace.apply_text_edits');
    const search = byName('workspace.search_text');
    const glob = byName('workspace.glob');
    const context = {
      runId: 'run-structured-file',
      effectId: 'effect-structured-file',
      toolCallId: 'call-structured-file',
      idempotencyKey: 'idempotency-structured-file',
      capabilityIds: ['workspace.read', 'workspace.write'],
      scope: ['workspace-structured-file'],
      signal: new AbortController().signal
    };

    expect(edit?.document).toMatchObject({
      toolVersion: '1.0.0',
      capabilityIds: ['workspace.write'],
      sideEffect: 'write',
      permission: { approval: 'required' }
    });
    expect(search?.document).toMatchObject({
      capabilityIds: ['workspace.read'],
      sideEffect: 'read',
      permission: { approval: 'never' }
    });
    expect(glob?.document).toMatchObject({
      capabilityIds: ['workspace.read'],
      sideEffect: 'read',
      permission: { approval: 'never' }
    });
    expect(edit?.executable.normalizeAndValidate({
      path: 'note.txt',
      expectedVersion: 'workspace-file-v1:' + 'a'.repeat(64),
      edits: [{
        start: { line: 0, column: 1 },
        end: { line: 1, column: 1 },
        text: ''
      }]
    })).toEqual({ status: 'rejected' });
    expect(glob?.executable.normalizeAndValidate({
      pattern: '**/*.txt',
      unexpected: true
    })).toEqual({ status: 'rejected' });

    const observed = await read?.executable.execute({ path: 'note.txt' }, context);
    if (
      observed?.status !== 'succeeded'
      || typeof observed.result !== 'object'
      || observed.result === null
      || Array.isArray(observed.result)
      || typeof observed.result.version !== 'string'
    ) throw new Error('workspace_structured_file_observation_missing');
    const observedVersion = observed.result.version;

    await expect(edit?.executable.execute({
      path: 'note.txt',
      expectedVersion: observedVersion,
      edits: [{
        start: { line: 1, column: 7 },
        end: { line: 1, column: 8 },
        text: '星'
      }, {
        start: { line: 2, column: 1 },
        end: { line: 2, column: 1 },
        text: 'found '
      }]
    }, context)).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        path: 'note.txt',
        operation: 'edited',
        appliedEdits: 2,
        diff: expect.stringContaining('+alpha 星 beta'),
        previousVersion: observedVersion,
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }
    });
    expect(readFileSync(target, 'utf8')).toBe('alpha 星 beta\r\nfound needle here\r\n');

    const searched = await search?.executable.execute({
      query: 'needle',
      includeGlob: '**/*.txt'
    }, context);
    expect(searched).toMatchObject({
      status: 'succeeded',
      result: {
        matches: [{
          path: 'note.txt',
          line: 2,
          column: 7,
          preview: 'found needle here',
          version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
        }],
        scannedFiles: 1,
        truncated: false
      }
    });
    await expect(glob?.executable.execute({ pattern: '**/*.txt' }, context))
      .resolves.toMatchObject({
        status: 'succeeded',
        result: {
          matches: [{ path: 'note.txt', kind: 'file' }],
          truncated: false
        }
      });

    writeFileSync(target, 'external', 'utf8');
    await expect(edit?.executable.execute({
      path: 'note.txt',
      expectedVersion: observedVersion,
      edits: [{
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
        text: 'agent '
      }]
    }, context)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'workspace_file_stale_version'
    });
    expect(readFileSync(target, 'utf8')).toBe('external');
  });

  it('moves and deletes only exact observed file versions and publishes the LSP contract', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-file-lifecycle-workspace-'));
    temporaryRoots.push(root);
    writeFileSync(path.join(root, 'source.ts'), 'export const value = 1\n', 'utf8');
    const catalog = await compileCapabilityCatalog([{
      workspaceId: 'workspace-file-lifecycle',
      label: 'File lifecycle workspace',
      rootPath: root,
      access: 'write'
    }]);
    const byName = (name: string) => catalog.entries.find(
      (entry) => entry.document.toolName === name
    );
    const read = byName('workspace.read_file');
    const move = byName('workspace.move_file');
    const remove = byName('workspace.delete_file');
    const lsp = byName('workspace.code_intelligence');
    const context = {
      runId: 'run-file-lifecycle',
      effectId: 'effect-file-lifecycle',
      toolCallId: 'call-file-lifecycle',
      idempotencyKey: 'idempotency-file-lifecycle',
      capabilityIds: ['workspace.read', 'workspace.write'],
      scope: ['workspace-file-lifecycle'],
      signal: new AbortController().signal
    };

    for (const tool of [move, remove]) {
      expect(tool?.document).toMatchObject({
        capabilityIds: ['workspace.write'],
        sideEffect: 'write',
        permission: { approval: 'required' },
        presentation: { kind: 'file_change', resultVisibility: 'protected' }
      });
    }
    expect(lsp?.document).toMatchObject({
      capabilityIds: ['workspace.read'],
      sideEffect: 'read',
      permission: { approval: 'never' },
      presentation: { kind: 'file_search', resultVisibility: 'protected' }
    });
    expect(lsp?.executable.normalizeAndValidate({
      operation: 'definition',
      path: 'source.ts'
    })).toEqual({ status: 'rejected' });

    const observed = await read?.executable.execute({ path: 'source.ts' }, context);
    const sourceVersion = toolResultVersion(observed);
    await expect(move?.executable.execute({
      sourcePath: 'source.ts',
      destinationPath: 'nested/moved.ts',
      expectedVersion: sourceVersion
    }, context)).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        sourcePath: 'source.ts',
        destinationPath: 'nested/moved.ts',
        operation: 'moved',
        previousVersion: sourceVersion
      }
    });
    expect(readFileSync(path.join(root, 'nested', 'moved.ts'), 'utf8'))
      .toBe('export const value = 1\n');

    const moved = await read?.executable.execute({ path: 'nested/moved.ts' }, context);
    const movedVersion = toolResultVersion(moved);
    await expect(remove?.executable.execute({
      path: 'nested/moved.ts',
      expectedVersion: movedVersion
    }, context)).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        path: 'nested/moved.ts',
        operation: 'deleted',
        previousVersion: movedVersion
      }
    });
    expect(() => readFileSync(path.join(root, 'nested', 'moved.ts'), 'utf8')).toThrow();
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
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.job_output')
      ?.document.lifecycleSemantics).toBe('resource_observe');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.job_write')
      ?.document.lifecycleSemantics).toBe('resource_mutate');
    expect(catalog.entries.find((entry) => entry.document.toolName === 'workspace.job_kill')
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

function toolResultVersion(
  outcome: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof compileCapabilityCatalog>>['entries'][number]>['executable']['execute']>> | undefined
): string {
  if (
    outcome?.status !== 'succeeded'
    || typeof outcome.result !== 'object'
    || outcome.result === null
    || Array.isArray(outcome.result)
    || typeof outcome.result.version !== 'string'
  ) throw new Error('workspace_tool_result_version_missing');
  return outcome.result.version;
}
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
