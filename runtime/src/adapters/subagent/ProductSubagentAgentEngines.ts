import { createHash } from 'node:crypto';
import {
  AgentInferenceDeterministicFailureError,
  type AgentDirective,
  type AgentEngine,
  type AgentJsonValue,
  type AgentTurnInput,
  type PreparedAgentDecision
} from '@ariadne/agent-core';
import type {
  ClaudeSubagentProviderConfiguration,
  CodexSubagentProviderConfiguration
} from '@ariadne/protocol/settings';

import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessSandbox
} from '../../control/ports/AgentProcessSandbox.js';

const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_ASSISTANT_BYTES = 1024 * 1024;

interface ProductEngineOptions<T> {
  readonly config: T;
  readonly workspaceRoots: ReadonlyMap<string, string>;
  readonly sandboxForWorkspace: (workspaceRoot: string) => AgentProcessSandbox;
}

export class CodexSubagentAgentEngine implements AgentEngine {
  public constructor(
    private readonly options: ProductEngineOptions<CodexSubagentProviderConfiguration>
  ) {}

  public async prepare(input: AgentTurnInput, signal: AbortSignal): Promise<PreparedAgentDecision> {
    const prepared = prepareProductInput(input, this.options, 'codex_app_server');
    signal.throwIfAborted();
    return {
      modelContext: productContext(this.options.config, 'codex_app_server'),
      decide: (decisionSignal) => runCodexTurn({
        ...prepared,
        config: this.options.config,
        signal: decisionSignal
      })
    };
  }
}

export class ClaudeSubagentAgentEngine implements AgentEngine {
  public constructor(
    private readonly options: ProductEngineOptions<ClaudeSubagentProviderConfiguration>
  ) {}

  public async prepare(input: AgentTurnInput, signal: AbortSignal): Promise<PreparedAgentDecision> {
    const prepared = prepareProductInput(input, this.options, 'claude_code');
    signal.throwIfAborted();
    return {
      modelContext: productContext(this.options.config, 'claude_code'),
      decide: (decisionSignal) => runClaudeTurn({
        ...prepared,
        config: this.options.config,
        signal: decisionSignal
      })
    };
  }
}

export function digestProductSubagentConfiguration(
  config: CodexSubagentProviderConfiguration | ClaudeSubagentProviderConfiguration
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(config), 'utf8').digest('hex')}`;
}

function productContext(
  config: CodexSubagentProviderConfiguration | ClaudeSubagentProviderConfiguration,
  transport: 'codex_app_server' | 'claude_code'
): AgentJsonValue {
  return {
    format: 'ariadne.product-subagent-context',
    schemaVersion: 1,
    providerId: config.providerId,
    configDigest: digestProductSubagentConfiguration(config),
    transport,
    sessionPersistence: 'one_shot',
    networkAccess: config.networkAccess,
    inheritsParentContext: false,
    usesParentTools: false
  };
}

function prepareProductInput<T extends CodexSubagentProviderConfiguration | ClaudeSubagentProviderConfiguration>(
  input: AgentTurnInput,
  options: ProductEngineOptions<T>,
  product: 'codex_app_server' | 'claude_code'
): { readonly workspaceRoot: string; readonly prompt: string; readonly sandbox: AgentProcessSandbox } {
  const objective = input.run.binding.objectiveRef;
  if (
    objective.kind !== 'parent_delegation'
    || objective.providerId !== options.config.providerId
    || objective.mode !== 'one_shot'
  ) throw deterministic(`${product}_child_authority_invalid`, 'Product Child authority is invalid.');
  const workspaceRoot = options.workspaceRoots.get(input.run.binding.workspace.workspaceId);
  if (workspaceRoot === undefined) {
    throw deterministic(`${product}_workspace_unavailable`, 'Product Child workspace is unavailable.');
  }
  const messages = input.messages.filter((message) => message.kind === 'text');
  const prompt = messages.at(-1)?.content.trim() ?? '';
  if (prompt.length === 0 || prompt.length > MAX_ASSISTANT_BYTES) {
    throw deterministic(`${product}_prompt_invalid`, 'Product Child prompt is invalid.');
  }
  return {
    workspaceRoot,
    prompt,
    sandbox: options.sandboxForWorkspace(workspaceRoot)
  };
}

interface CodexRunInput {
  readonly config: CodexSubagentProviderConfiguration;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly sandbox: AgentProcessSandbox;
  readonly signal: AbortSignal;
}

async function runCodexTurn(input: CodexRunInput): Promise<AgentDirective> {
  input.signal.throwIfAborted();
  let client: CodexJsonRpcClient | undefined;
  const lease = input.sandbox.openFileLease({
    file: input.config.command,
    args: [...input.config.args, 'app-server', '--stdio'],
    cwd: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    mode: input.sandbox.mode,
    networkMode: input.config.networkAccess,
    timeoutMs: input.config.timeoutMs,
    maxOutputBytes: MAX_PROTOCOL_BYTES,
    signal: input.signal
  }, {
    onStdout: (chunk) => client?.accept(chunk),
    onStderr: () => undefined
  });
  client = new CodexJsonRpcClient(lease);
  const completion = lease.completion.then((result) => {
    client?.processSettled(result);
    return result;
  });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'ariadne', title: 'Ariadne', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    await client.notify('initialized', {});
    const permissions = codexThreadPermissions(input.config.permissionPolicy, input.sandbox.mode);
    const started = exactObject(await client.request('thread/start', {
      cwd: input.workspaceRoot,
      ephemeral: true,
      ...(input.config.model === undefined ? {} : { model: input.config.model }),
      ...permissions
    }), 'thread/start');
    const thread = exactObject(started.thread, 'thread/start.thread');
    const threadId = nonEmptyString(thread.id, 'thread/start.thread.id');
    const turnStarted = exactObject(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }]
    }), 'turn/start');
    const turn = exactObject(turnStarted.turn, 'turn/start.turn');
    const turnId = nonEmptyString(turn.id, 'turn/start.turn.id');
    const content = await client.waitForTurn(threadId, turnId, input.signal);
    await lease.signal('terminate');
    await completion;
    return { kind: 'respond', content };
  } catch (error) {
    await lease.signal('kill').catch(() => undefined);
    await completion.catch(() => undefined);
    if (input.signal.aborted) throw input.signal.reason;
    throw deterministic('codex_app_server_failed', safeProductFailure(error, 'Codex app-server failed.'));
  }
}

function codexThreadPermissions(
  policy: CodexSubagentProviderConfiguration['permissionPolicy'],
  sandboxMode: AgentProcessSandbox['mode']
): Record<string, unknown> {
  if (policy === 'danger-full-access') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
  if (policy === 'approve-for-me') {
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: sandboxMode === 'read-only' ? 'read-only' : 'workspace-write'
    };
  }
  return {
    approvalPolicy: 'never',
    sandbox: sandboxMode === 'read-only' ? 'read-only' : 'workspace-write'
  };
}

class CodexJsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private bytes = 0;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private activeTurn?: {
    threadId: string;
    turnId: string;
    answer?: string;
    resolve(value: string): void;
    reject(error: Error): void;
  };

  public constructor(private readonly lease: AgentProcessLease) {}

  public request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  public notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  public waitForTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.activeTurn = { threadId, turnId, resolve, reject };
      const abort = (): void => reject(signal.reason instanceof Error
        ? signal.reason
        : new Error('Codex turn was cancelled.'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  public accept(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_PROTOCOL_BYTES) return this.fail(new Error('Codex protocol output exceeded its bound.'));
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try { this.handle(exactObject(JSON.parse(line), 'JSON-RPC frame')); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  public processSettled(result: AgentProcessExecutionResult): void {
    if (this.pending.size === 0 && this.activeTurn === undefined) return;
    this.fail(new Error(`Codex app-server ended before protocol completion (${result.errorCode ?? 'process_exit'}).`));
  }

  private handle(frame: Record<string, unknown>): void {
    if (typeof frame.id === 'number' && typeof frame.method !== 'string') {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      this.pending.delete(frame.id);
      if (frame.error !== undefined) pending.reject(new Error('Codex app-server rejected a request.'));
      else pending.resolve(frame.result);
      return;
    }
    if (typeof frame.method !== 'string') throw new Error('Invalid Codex JSON-RPC frame.');
    const params = exactObject(frame.params ?? {}, `${frame.method}.params`);
    if (typeof frame.id === 'number') {
      void this.answerServerRequest(frame.id, frame.method, params);
      return;
    }
    this.handleNotification(frame.method, params);
  }

  private async answerServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    let result: unknown;
    if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null, _meta: null };
    else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
      result = { decision: available.includes('cancel') ? 'cancel' : 'decline' };
    } else {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported unattended request.' } });
      return;
    }
    await this.write({ jsonrpc: '2.0', id, result });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const active = this.activeTurn;
    if (active === undefined || params.threadId !== active.threadId) return;
    if (method === 'item/completed' && params.turnId === active.turnId) {
      const item = exactObject(params.item, 'item/completed.item');
      if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase === null)) {
        active.answer = nonEmptyString(item.text, 'agentMessage.text');
      }
      return;
    }
    if (method !== 'turn/completed') return;
    const turn = exactObject(params.turn, 'turn/completed.turn');
    if (turn.id !== active.turnId) return;
    this.activeTurn = undefined;
    if (turn.status !== 'completed' || active.answer === undefined) {
      active.reject(new Error('Codex turn did not complete with a final answer.'));
      return;
    }
    active.resolve(active.answer);
  }

  private async write(frame: Record<string, unknown>): Promise<void> {
    await this.lease.writeStdin(`${JSON.stringify(frame)}\n`);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
  }
}

interface ClaudeRunInput {
  readonly config: ClaudeSubagentProviderConfiguration;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly sandbox: AgentProcessSandbox;
  readonly signal: AbortSignal;
}

async function runClaudeTurn(input: ClaudeRunInput): Promise<AgentDirective> {
  const lease = input.sandbox.openFileLease({
    file: input.config.command,
    args: [
      ...input.config.args,
      '--print',
      '--output-format', 'json',
      '--permission-mode', input.config.permissionPolicy,
      '--no-session-persistence',
      ...(input.config.model === undefined ? [] : ['--model', input.config.model])
    ],
    cwd: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    mode: input.sandbox.mode,
    networkMode: input.config.networkAccess,
    timeoutMs: input.config.timeoutMs,
    maxOutputBytes: MAX_PROTOCOL_BYTES,
    signal: input.signal
  });
  try {
    await lease.writeStdin(input.prompt);
    await lease.endStdin();
    const result = await lease.completion;
    assertSuccessfulProcess(result, 'Claude Code');
    const payload = exactObject(JSON.parse(result.stdout.trim()), 'Claude Code result');
    if (
      payload.type !== 'result'
      || payload.subtype !== 'success'
      || payload.is_error !== false
    ) throw new Error('Claude Code returned a non-success result.');
    const content = nonEmptyString(payload.result, 'Claude Code result.result');
    if (Buffer.byteLength(content, 'utf8') > MAX_ASSISTANT_BYTES) {
      throw new Error('Claude Code result exceeded its bound.');
    }
    return { kind: 'respond', content };
  } catch (error) {
    await lease.signal('kill').catch(() => undefined);
    if (input.signal.aborted) throw input.signal.reason;
    throw deterministic('claude_code_failed', safeProductFailure(error, 'Claude Code failed.'));
  }
}

function assertSuccessfulProcess(result: AgentProcessExecutionResult, product: string): void {
  if (
    result.spawnFailed
    || result.timedOut
    || result.truncated
    || result.exitCode !== 0
  ) throw new Error(`${product} process did not exit successfully.`);
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ASSISTANT_BYTES) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeProductFailure(error: unknown, fallback: string): string {
  if (error instanceof AgentInferenceDeterministicFailureError) return error.sanitizedMessage;
  return fallback;
}

function deterministic(code: string, message: string): AgentInferenceDeterministicFailureError {
  return new AgentInferenceDeterministicFailureError(code, message);
}
