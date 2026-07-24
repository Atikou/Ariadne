import { randomBytes, randomUUID } from 'node:crypto';

import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpRemoteCapabilityOperation } from '@ariadne/protocol/host';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import type { McpOAuthCredentialVault } from '../persistence/mcp-oauth-credential-vault';

const REDIRECT_URL = new URL('ariadne://oauth/mcp');
const AUTHORIZATION_TIMEOUT_MS = 4 * 60_000;
const MAX_QUEUED_MESSAGES = 256;

type TransportFactory = (
  endpoint: URL,
  provider?: OAuthClientProvider
) => MainTransport;

interface MainTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onclose?: (() => void) | undefined;
  finishAuth?(authorizationCode: string): Promise<void>;
}

interface ReceiveResult extends Record<string, unknown> {
  messages: JSONRPCMessage[];
  closed: boolean;
  error?: string;
}

interface ConnectionState {
  serverId: string;
  endpoint: string;
  credentialRef?: string;
  transport: MainTransport;
  provider?: MainMcpOAuthProvider;
  messages: JSONRPCMessage[];
  closed: boolean;
  error?: string;
  receiveWaiter?: {
    resolve(result: Record<string, unknown>): void;
    timer: NodeJS.Timeout;
  } | undefined;
}

/**
 * Main-owned MCP Streamable HTTP broker. The official SDK, bearer tokens,
 * refresh tokens and PKCE verifier remain in Electron Main. Runtime sees only
 * JSON-RPC messages over the typed capability channel.
 */
export class McpRemoteService {
  private readonly connections = new Map<string, ConnectionState>();
  private allowedServers = new Map<string, RemoteMcpPolicy>();

  constructor(
    private readonly vault: McpOAuthCredentialVault,
    private readonly openAuthorizationUrl: (url: string) => Promise<void>,
    private readonly transportFactory: TransportFactory = createTransport
  ) {}

  async configure(servers: RuntimePolicySnapshot['mcp']['servers']): Promise<void> {
    const allowed = new Map<string, RemoteMcpPolicy>();
    for (const server of servers) {
      if (server.enabled && server.transport === 'streamable-http') {
        allowed.set(server.id, structuredClone(server));
      }
    }
    this.allowedServers = allowed;
    await Promise.all([...this.connections.entries()]
      .filter(([_, connection]) => !matchesPolicy(
        allowed.get(connection.serverId),
        connection.serverId,
        connection.endpoint,
        connection.credentialRef
      ))
      .map(([connectionId]) => this.close(connectionId)));
  }

  async handle(operation: McpRemoteCapabilityOperation): Promise<Record<string, unknown>> {
    switch (operation.kind) {
      case 'mcp.remote.connect':
        return this.connect(
          operation.serverId,
          operation.endpoint,
          operation.credentialRef
        );
      case 'mcp.remote.send':
        await this.send(operation.connectionId, operation.message as JSONRPCMessage);
        return {};
      case 'mcp.remote.receive':
        return this.receive(operation.connectionId, operation.maxWaitMs);
      case 'mcp.remote.close':
        await this.close(operation.connectionId);
        return {};
    }
  }

  async handleOAuthCallback(rawUrl: string): Promise<boolean> {
    const callback = new URL(rawUrl);
    if (
      callback.protocol !== REDIRECT_URL.protocol
      || callback.hostname !== REDIRECT_URL.hostname
      || callback.pathname !== REDIRECT_URL.pathname
    ) {
      return false;
    }
    const state = callback.searchParams.get('state');
    const code = callback.searchParams.get('code');
    const oauthError = callback.searchParams.get('error');
    if (
      !state
      || state.length > 512
      || ((!code || code.length > 8_192) && !oauthError)
      || (oauthError !== null && oauthError.length > 512)
    ) {
      throw new Error('mcp_oauth_callback_invalid');
    }
    for (const connection of this.connections.values()) {
      if (!connection.provider) continue;
      const accepted = oauthError
        ? await connection.provider.rejectAuthorization(state, oauthError)
        : await connection.provider.acceptAuthorizationCode(state, code!);
      if (accepted) return true;
    }
    throw new Error('mcp_oauth_callback_state_unknown');
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((connectionId) =>
      this.close(connectionId)));
  }

  private async connect(
    serverId: string,
    endpointValue: string,
    credentialRef?: string
  ): Promise<Record<string, unknown>> {
    const endpoint = new URL(endpointValue);
    assertHttpsEndpoint(endpoint);
    if (!matchesPolicy(
      this.allowedServers.get(serverId),
      serverId,
      endpoint.toString(),
      credentialRef
    )) {
      throw new Error('mcp_remote_policy_denied');
    }
    const provider = credentialRef
      ? new MainMcpOAuthProvider(credentialRef, this.vault, this.openAuthorizationUrl)
      : undefined;
    const transport = this.transportFactory(endpoint, provider);
    const connectionId = randomUUID();
    const connection: ConnectionState = {
      serverId,
      endpoint: endpoint.toString(),
      ...(credentialRef ? { credentialRef } : {}),
      transport,
      ...(provider ? { provider } : {}),
      messages: [],
      closed: false
    };
    transport.onmessage = (message) => this.acceptMessage(connectionId, message);
    transport.onerror = (error) => {
      if (error instanceof UnauthorizedError) return;
      this.acceptError(connectionId, error);
    };
    transport.onclose = () => this.acceptClose(connectionId);
    this.connections.set(connectionId, connection);
    try {
      await transport.start();
      return { connectionId };
    } catch (error) {
      this.connections.delete(connectionId);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  private async send(connectionId: string, message: JSONRPCMessage): Promise<void> {
    const connection = this.requireConnection(connectionId);
    try {
      await connection.transport.send(message);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !connection.provider) throw error;
      const authorizationCode = await connection.provider.waitForAuthorizationCode(
        AUTHORIZATION_TIMEOUT_MS
      );
      if (!connection.transport.finishAuth) throw new Error('mcp_oauth_transport_unsupported');
      await connection.transport.finishAuth(authorizationCode);
      await connection.transport.send(message);
    }
  }

  private receive(connectionId: string, maxWaitMs: number): Promise<Record<string, unknown>> {
    const connection = this.requireConnection(connectionId, true);
    const immediate = drainConnection(connection);
    if (immediate.messages.length > 0 || immediate.closed || maxWaitMs === 0) {
      return Promise.resolve(immediate);
    }
    if (connection.receiveWaiter) throw new Error('mcp_remote_receive_already_pending');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (connection.receiveWaiter?.timer !== timer) return;
        connection.receiveWaiter = undefined;
        resolve(drainConnection(connection));
      }, maxWaitMs);
      timer.unref?.();
      connection.receiveWaiter = { resolve, timer };
    });
  }

  private async close(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    connection.closed = true;
    connection.provider?.cancelAuthorization('mcp_oauth_connection_closed');
    this.resolveReceive(connection);
    await connection.transport.close().catch(() => undefined);
  }

  private acceptMessage(connectionId: string, message: JSONRPCMessage): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.closed) return;
    if (connection.messages.length >= MAX_QUEUED_MESSAGES) {
      connection.error = 'mcp_remote_message_queue_overflow';
      connection.closed = true;
      void connection.transport.close().catch(() => undefined);
    } else {
      connection.messages.push(structuredClone(message));
    }
    this.resolveReceive(connection);
  }

  private acceptError(connectionId: string, error: Error): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.closed) return;
    connection.error = `mcp_remote_transport_error:${error.message}`.slice(0, 1_024);
    this.resolveReceive(connection);
  }

  private acceptClose(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.closed) return;
    connection.closed = true;
    connection.provider?.cancelAuthorization('mcp_oauth_transport_closed');
    this.resolveReceive(connection);
  }

  private resolveReceive(connection: ConnectionState): void {
    const waiter = connection.receiveWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    connection.receiveWaiter = undefined;
    waiter.resolve(drainConnection(connection));
  }

  private requireConnection(connectionId: string, allowClosed = false): ConnectionState {
    const connection = this.connections.get(connectionId);
    if (!connection || (!allowClosed && connection.closed)) {
      throw new Error('mcp_remote_connection_not_found');
    }
    return connection;
  }
}

type RemoteMcpPolicy = Extract<
  RuntimePolicySnapshot['mcp']['servers'][number],
  { transport: 'streamable-http' }
>;

class MainMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = REDIRECT_URL;
  readonly clientMetadata: OAuthClientMetadata = {
    redirect_uris: [REDIRECT_URL.toString()],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Ariadne',
    software_id: 'com.ariadne.desktop',
    software_version: '2.0'
  };

  private pending?: {
    resolve(code: string): void;
    reject(error: Error): void;
    promise: Promise<string>;
  } | undefined;

  constructor(
    private readonly credentialRef: string,
    private readonly vault: McpOAuthCredentialVault,
    private readonly openAuthorizationUrl: (url: string) => Promise<void>
  ) {}

  state(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    return this.vault.saveExpectedState(this.credentialRef, state).then(() => state);
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.vault.clientInformation(this.credentialRef);
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return this.vault.saveClientInformation(this.credentialRef, clientInformation);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.vault.tokens(this.credentialRef);
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.vault.saveTokens(this.credentialRef, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    assertHttpsEndpoint(authorizationUrl);
    if (this.pending) throw new Error('mcp_oauth_authorization_already_pending');
    let resolve!: (code: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pending = { resolve, reject, promise };
    await this.openAuthorizationUrl(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.vault.saveCodeVerifier(this.credentialRef, codeVerifier);
  }

  codeVerifier(): Promise<string> {
    return this.vault.codeVerifier(this.credentialRef);
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    return this.vault.saveDiscoveryState(this.credentialRef, discoveryState);
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.vault.discoveryState(this.credentialRef);
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    return this.vault.invalidate(this.credentialRef, scope);
  }

  async acceptAuthorizationCode(state: string, code: string): Promise<boolean> {
    if (!this.pending) return false;
    try {
      await this.vault.consumeExpectedState(this.credentialRef, state);
    } catch {
      return false;
    }
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(code);
    return true;
  }

  async rejectAuthorization(state: string, oauthError: string): Promise<boolean> {
    if (!this.pending) return false;
    try {
      await this.vault.consumeExpectedState(this.credentialRef, state);
    } catch {
      return false;
    }
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(new Error(`mcp_oauth_authorization_denied:${oauthError}`));
    return true;
  }

  async waitForAuthorizationCode(timeoutMs: number): Promise<string> {
    const pending = this.pending;
    if (!pending) throw new Error('mcp_oauth_authorization_not_started');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('mcp_oauth_authorization_timeout')), timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  cancelAuthorization(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.reject(new Error(reason));
  }
}

function createTransport(
  endpoint: URL,
  provider?: OAuthClientProvider
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    ...(provider ? { authProvider: provider } : {}),
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 2
    }
  });
}

function drainConnection(connection: ConnectionState): ReceiveResult {
  const messages = connection.messages.splice(0, connection.messages.length);
  const result: ReceiveResult = {
    messages,
    closed: connection.closed,
    ...(connection.error ? { error: connection.error } : {})
  };
  delete connection.error;
  return result;
}

function assertHttpsEndpoint(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('mcp_remote_https_required');
  }
}

function matchesPolicy(
  policy: RemoteMcpPolicy | undefined,
  serverId: string,
  endpoint: string,
  credentialRef: string | undefined
): boolean {
  return Boolean(
    policy
    && policy.id === serverId
    && new URL(policy.endpoint).toString() === new URL(endpoint).toString()
    && policy.credentialRef === credentialRef
  );
}
