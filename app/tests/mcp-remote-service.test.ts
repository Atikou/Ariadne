import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpOAuthCredentialVault } from '../src/main/persistence/mcp-oauth-credential-vault';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';
import { McpRemoteService } from '../src/main/runtime/mcp-remote-service';

const temporaryDirectories: string[] = [];
const cipher: SecretCipher = {
  encrypt: (value) => `cipher:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(value.replace(/^cipher:/u, ''), 'base64').toString('utf8')
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(tmpdir())) throw new Error('Refusing unsafe test cleanup.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Main MCP remote service', () => {
  it('keeps OAuth tokens in encrypted Main storage and validates PKCE state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-mcp-oauth-'));
    temporaryDirectories.push(directory);
    const vaultPath = join(directory, 'mcp-oauth-vault.json');
    const vault = new McpOAuthCredentialVault(vaultPath, cipher);
    await vault.initialize();

    const authorizationUrls: string[] = [];
    let provider: OAuthClientProvider | undefined;
    let state = '';
    let sends = 0;
    const finishAuth = vi.fn(async (code: string) => {
      expect(code).toBe('authorization-code');
      await provider!.saveTokens({
        access_token: 'main-only-access-token',
        refresh_token: 'main-only-refresh-token',
        token_type: 'Bearer'
      });
    });
    const transport = {
      onmessage: undefined as ((message: JSONRPCMessage) => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        sends += 1;
        if (sends !== 1) return;
        state = await provider!.state!();
        await provider!.saveCodeVerifier('v'.repeat(64));
        await provider!.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${state}`)
        );
        throw new UnauthorizedError();
      }),
      finishAuth,
      close: vi.fn(async () => undefined)
    };
    const service = new McpRemoteService(
      vault,
      async (url) => {
        authorizationUrls.push(url);
      },
      (_endpoint, oauthProvider) => {
        provider = oauthProvider;
        return transport;
      }
    );
    await service.configure([{
      id: 'secure',
      enabled: true,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/messages',
      credentialRef: 'mcp.secure'
    }]);
    const connected = await service.handle({
      kind: 'mcp.remote.connect',
      serverId: 'secure',
      endpoint: 'https://mcp.example.test/messages',
      credentialRef: 'mcp.secure'
    });
    const connectionId = String(connected.connectionId);
    const send = service.handle({
      kind: 'mcp.remote.send',
      connectionId,
      message: { jsonrpc: '2.0', id: 1, method: 'initialize' }
    });
    await vi.waitFor(() => expect(authorizationUrls).toHaveLength(1));

    await expect(service.handleOAuthCallback(
      'ariadne://oauth/mcp?code=attacker&state=wrong-state-value'
    )).rejects.toThrow('mcp_oauth_callback_state_unknown');
    expect(finishAuth).not.toHaveBeenCalled();

    await expect(service.handleOAuthCallback(
      `ariadne://oauth/mcp?code=authorization-code&state=${state}`
    )).resolves.toBe(true);
    await send;
    expect(finishAuth).toHaveBeenCalledOnce();
    expect(transport.send).toHaveBeenCalledTimes(2);

    const persisted = await readFile(vaultPath, 'utf8');
    expect(persisted).not.toContain('main-only-access-token');
    expect(persisted).not.toContain('main-only-refresh-token');
    expect(JSON.stringify(connected)).not.toContain('token');
    await service.dispose();
  });

  it('long-polls parsed JSON-RPC messages through an opaque connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-mcp-remote-'));
    temporaryDirectories.push(directory);
    const vault = new McpOAuthCredentialVault(join(directory, 'vault.json'), cipher);
    await vault.initialize();
    const transport = {
      onmessage: undefined as ((message: JSONRPCMessage) => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };
    const service = new McpRemoteService(
      vault,
      async () => undefined,
      () => transport
    );
    await service.configure([{
      id: 'public',
      enabled: true,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/messages'
    }]);
    await expect(service.handle({
      kind: 'mcp.remote.connect',
      serverId: 'public',
      endpoint: 'https://attacker.example.test/messages'
    })).rejects.toThrow('mcp_remote_policy_denied');
    const connected = await service.handle({
      kind: 'mcp.remote.connect',
      serverId: 'public',
      endpoint: 'https://mcp.example.test/messages'
    });
    const connectionId = String(connected.connectionId);
    const receive = service.handle({
      kind: 'mcp.remote.receive',
      connectionId,
      maxWaitMs: 1_000
    });
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 7,
      result: { tools: [] }
    });
    await expect(receive).resolves.toEqual({
      messages: [{ jsonrpc: '2.0', id: 7, result: { tools: [] } }],
      closed: false
    });
    await service.dispose();
  });

  it('propagates a validated OAuth denial without retrying the MCP request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ariadne-mcp-denied-'));
    temporaryDirectories.push(directory);
    const vault = new McpOAuthCredentialVault(join(directory, 'vault.json'), cipher);
    await vault.initialize();
    let provider: OAuthClientProvider | undefined;
    let state = '';
    const transport = {
      onmessage: undefined as ((message: JSONRPCMessage) => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        state = await provider!.state!();
        await provider!.saveCodeVerifier('d'.repeat(64));
        await provider!.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${state}`)
        );
        throw new UnauthorizedError();
      }),
      finishAuth: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };
    const opened = vi.fn(async () => undefined);
    const service = new McpRemoteService(vault, opened, (_endpoint, oauthProvider) => {
      provider = oauthProvider;
      return transport;
    });
    await service.configure([{
      id: 'denied',
      enabled: true,
      trustAnnotations: false,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/messages',
      credentialRef: 'mcp.denied'
    }]);
    const connected = await service.handle({
      kind: 'mcp.remote.connect',
      serverId: 'denied',
      endpoint: 'https://mcp.example.test/messages',
      credentialRef: 'mcp.denied'
    });
    const send = service.handle({
      kind: 'mcp.remote.send',
      connectionId: String(connected.connectionId),
      message: { jsonrpc: '2.0', id: 2, method: 'initialize' }
    });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const denied = expect(send).rejects.toThrow(
      'mcp_oauth_authorization_denied:access_denied'
    );
    await expect(service.handleOAuthCallback(
      `ariadne://oauth/mcp?error=access_denied&state=${state}`
    )).resolves.toBe(true);
    await denied;
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledOnce();
    await service.dispose();
  });
});
