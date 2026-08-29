import { createHash } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  client as createAcpClient,
  methods,
  ndJsonStream,
  type ContentBlock,
  type StopReason,
  type ToolKind
} from '@agentclientprotocol/sdk';
import {
  AgentInferenceCancellationAcknowledgedError,
  AgentInferenceDeterministicFailureError,
  type AgentDirective,
  type AgentEngine,
  type AgentTurnInput,
  type PreparedAgentDecision
} from '@ariadne/agent-core';
import type { AcpSubagentProviderBootstrap } from '@ariadne/protocol/host';

import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessSandbox
} from '../../control/ports/AgentProcessSandbox.js';

const MAX_ASSISTANT_BYTES = 1_048_576;
const MAX_PROTOCOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const ACP_TOOL_KINDS = new Set<string>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think',
  'fetch', 'switch_mode', 'other'
]);

export interface AcpSubagentAgentEngineOptions {
  readonly config: AcpSubagentProviderBootstrap;
  readonly workspaceRoots: ReadonlyMap<string, string>;
  readonly sandboxForWorkspace: (workspaceRoot: string) => AgentProcessSandbox;
}

/** Fresh-process, one-shot ACP engine. Only cwd and delegated prompt cross the boundary. */
export class AcpSubagentAgentEngine implements AgentEngine {
  private readonly configDigest: string;

  public constructor(private readonly options: AcpSubagentAgentEngineOptions) {
    this.configDigest = digestAcpSubagentConfiguration(options.config);
  }

  public async prepare(
    input: AgentTurnInput,
    signal: AbortSignal
  ): Promise<PreparedAgentDecision> {
    signal.throwIfAborted();
    const objective = input.run.binding.objectiveRef;
    if (
      objective.kind !== 'parent_delegation'
      || objective.providerId !== this.options.config.providerId
      || objective.mode !== 'one_shot'
    ) throw deterministic('acp_child_authority_invalid', 'ACP Child authority is invalid.');
    const workspaceRoot = this.options.workspaceRoots.get(
      input.run.binding.workspace.workspaceId
    );
    if (workspaceRoot === undefined) {
      throw deterministic('acp_workspace_unavailable', 'ACP Child workspace is unavailable.');
    }
    const prompt = delegatedPrompt(input);
    const mode = input.run.binding.workspace.access === 'write'
      ? 'workspace-write' as const
      : 'read-only' as const;
    const networkAccess = effectiveNetworkAccess(input, this.options.config);
    const allowedToolKinds = effectiveAllowedToolKinds(
      input,
      this.options.config,
      networkAccess
    );
    return {
      modelContext: {
        format: 'ariadne.acp-subagent-context',
        schemaVersion: 1,
        providerId: this.options.config.providerId,
        configDigest: this.configDigest,
        transport: 'acp_stdio',
        inheritsParentContext: false,
        permissionPolicy: allowedToolKinds.size === 0 ? 'reject' : 'allow_authorized',
        allowedToolKinds: [...allowedToolKinds].sort(),
        networkAccess
      },
      decide: (decisionSignal) => runAcpTurn({
        config: this.options.config,
        workspaceRoot,
        mode,
        prompt,
        networkAccess,
        allowedToolKinds,
        sandbox: this.options.sandboxForWorkspace(workspaceRoot),
        signal: decisionSignal
      })
    };
  }
}

export function digestAcpSubagentConfiguration(
  config: AcpSubagentProviderBootstrap
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(config), 'utf8')
    .digest('hex')}`;
}

interface AcpTurnRequest {
  readonly config: AcpSubagentProviderBootstrap;
  readonly workspaceRoot: string;
  readonly mode: 'read-only' | 'workspace-write';
  readonly prompt: string;
  readonly networkAccess: 'offline' | 'online-approved';
  readonly allowedToolKinds: ReadonlySet<ToolKind>;
  readonly sandbox: AgentProcessSandbox;
  readonly signal: AbortSignal;
}

async function runAcpTurn(request: AcpTurnRequest): Promise<AgentDirective> {
  request.signal.throwIfAborted();
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let inputClosed = false;
  let lease: AgentProcessLease | undefined;
  let sessionId: string | undefined;
  let promptStarted = false;
  let outputBytes = 0;
  let outputOverflow = false;
  const output: string[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => { inputController = controller; }
  });
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      if (lease === undefined) throw new Error('acp_process_not_started');
      await lease.writeStdin(Buffer.from(chunk));
    },
    close: async () => lease?.endStdin()
  });
  const closeInput = (error?: Error): void => {
    if (inputClosed) return;
    inputClosed = true;
    if (error === undefined) inputController?.close();
    else inputController?.error(error);
  };

  lease = request.sandbox.openFileLease({
    file: request.config.command,
    args: [...request.config.args],
    cwd: request.workspaceRoot,
    workspaceRoot: request.workspaceRoot,
    mode: request.mode,
    networkMode: request.networkAccess,
    timeoutMs: request.config.timeoutMs,
    maxOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
    signal: request.signal
  }, {
    onStdout: (chunk) => {
      if (!inputClosed) inputController?.enqueue(new Uint8Array(chunk));
    }
  });
  void lease.completion.then((result) => {
    closeInput(processFailure(result));
  }, (error: unknown) => closeInput(asError(error)));

  const client = createAcpClient({ name: 'ariadne-subagent-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate !== 'agent_message_chunk') return Promise.resolve();
      const text = contentText(update.content);
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > MAX_ASSISTANT_BYTES) {
        outputOverflow = true;
        lease?.cancel();
        return Promise.resolve();
      }
      output.push(text);
      return Promise.resolve();
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const toolKind = safeToolKind(params.toolCall.kind);
      if (toolKind !== 'unknown' && request.allowedToolKinds.has(toolKind)) {
        const allowed = params.options.find((option) => (
          option.kind === 'allow_once' || option.kind === 'allow_always'
        ));
        if (allowed !== undefined) {
          return Promise.resolve({
            outcome: { outcome: 'selected' as const, optionId: allowed.optionId }
          });
        }
      }
      // Titles, arguments and option text are intentionally not logged or returned.
      return Promise.resolve({ outcome: { outcome: 'cancelled' as const } });
    });
  const connection = client.connect(ndJsonStream(writable, readable));
  const agent = connection.agent;
  const abort = (): void => {
    if (sessionId !== undefined) {
      void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
    }
    lease?.cancel();
  };
  request.signal.addEventListener('abort', abort, { once: true });

  try {
    await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    });
    const session = await agent.request(methods.agent.session.new, {
      cwd: request.workspaceRoot,
      mcpServers: []
    });
    sessionId = session.sessionId;
    request.signal.throwIfAborted();
    promptStarted = true;
    const result = await agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: request.prompt }]
    });
    if (outputOverflow) {
      throw deterministic('acp_output_too_large', 'ACP Child output exceeded the safe limit.');
    }
    return directiveForStopReason(result.stopReason, output.join(''));
  } catch (error) {
    if (request.signal.aborted) {
      throw new AgentInferenceCancellationAcknowledgedError(
        lease.executionId,
        'ACP Child inference was cancelled.'
      );
    }
    if (error instanceof AgentInferenceDeterministicFailureError) throw error;
    if (!promptStarted) {
      throw deterministic('acp_startup_failed', 'ACP Child could not start safely.');
    }
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
    await disposeLease(lease, request.config.disposeGraceMs);
  }
}

function delegatedPrompt(input: AgentTurnInput): string {
  if (input.messages.some((message) => message.kind !== 'text')) {
    throw deterministic('acp_child_input_invalid', 'ACP Child input must be fresh text.');
  }
  const users = input.messages.filter((message): message is Extract<
    AgentTurnInput['messages'][number],
    { readonly kind: 'text' }
  > => (
    message.kind === 'text' && message.role === 'user'
  ));
  const prompt = users.length === 1 ? users[0]?.content : undefined;
  if (prompt === undefined || prompt.length === 0 || prompt.length > 1_048_576) {
    throw deterministic('acp_child_input_invalid', 'ACP Child objective is invalid.');
  }
  return prompt;
}

function directiveForStopReason(reason: StopReason, content: string): AgentDirective {
  if (reason === 'cancelled') {
    throw deterministic('acp_remote_cancelled', 'ACP Child cancelled the delegated objective.');
  }
  if (reason !== 'end_turn') {
    throw deterministic(`acp_${reason}`, `ACP Child stopped without completing (${reason}).`);
  }
  if (content.trim().length === 0) {
    throw deterministic('acp_empty_response', 'ACP Child returned no assistant text.');
  }
  return { kind: 'respond', content };
}

async function disposeLease(lease: AgentProcessLease, graceMs: number): Promise<void> {
  await lease.endStdin().catch(() => undefined);
  if (await settlesWithin(lease.completion, graceMs)) return;
  lease.cancel();
  if (!(await settlesWithin(lease.completion, graceMs))) {
    throw new Error('acp_process_tree_not_quiescent');
  }
}

async function settlesWithin(
  completion: Promise<AgentProcessExecutionResult>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function processFailure(result: AgentProcessExecutionResult): Error | undefined {
  if (
    result.spawnFailed
    || result.timedOut
    || result.errorCode !== undefined
    || (result.exitCode !== undefined && result.exitCode !== 0)
  ) return new Error(`acp_process_exit:${result.errorCode ?? result.exitCode ?? 'unknown'}`);
  return undefined;
}

function contentText(content: ContentBlock): string {
  return content.type === 'text' ? content.text : '';
}

function safeToolKind(kind: ToolKind | null | undefined): ToolKind | 'unknown' {
  const value = kind ?? 'unknown';
  return ACP_TOOL_KINDS.has(value) ? value as ToolKind : 'unknown';
}

function effectiveAllowedToolKinds(
  input: AgentTurnInput,
  config: AcpSubagentProviderBootstrap,
  networkAccess: 'offline' | 'online-approved'
): ReadonlySet<ToolKind> {
  if (
    config.permissionPolicy !== 'allow'
    || input.run.binding.policy.permissionMode !== 'trusted'
  ) return new Set();
  const capabilities = new Set(
    input.run.binding.capabilities.map((grant) => grant.capabilityId)
  );
  const allowed = new Set<ToolKind>(['think']);
  if (capabilities.has('workspace.read')) {
    allowed.add('read');
    allowed.add('search');
  }
  if (
    input.run.binding.workspace.access === 'write'
    && capabilities.has('workspace.write')
  ) {
    allowed.add('edit');
    allowed.add('delete');
    allowed.add('move');
  }
  if (capabilities.has('workspace.shell')) allowed.add('execute');
  if (
    networkAccess === 'online-approved'
    && (capabilities.has('browser.use') || capabilities.has('mcp.use'))
  ) allowed.add('fetch');
  return allowed;
}

function effectiveNetworkAccess(
  input: AgentTurnInput,
  config: AcpSubagentProviderBootstrap
): 'offline' | 'online-approved' {
  if (
    config.networkAccess !== 'online-approved'
    || input.run.binding.policy.permissionMode !== 'trusted'
  ) return 'offline';
  const capabilities = new Set(
    input.run.binding.capabilities.map((grant) => grant.capabilityId)
  );
  return capabilities.has('browser.use') || capabilities.has('mcp.use')
    ? 'online-approved'
    : 'offline';
}

function deterministic(code: string, message: string): AgentInferenceDeterministicFailureError {
  return new AgentInferenceDeterministicFailureError(code, message);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
