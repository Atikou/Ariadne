import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModelClient } from '../model/ModelFactory.js';
import { loadConfig } from '../config/loadConfig.js';
import { LocalModelService } from '../model/local/LocalModelService.js';
import type { ChatMessage, ModelClient, TokenCount } from '../model/types.js';
import {
  admitV3TokenizedProjections,
  planV3LongContext,
  type V3ModelContextGroup
} from '../adapters/model/V3LongContextLifecycle.js';
import type { ExactAgentModelInferenceMessage } from '../control/ports/AgentModelInference.js';

type AcceptanceTarget = 'local' | 'remote';

interface RestartAcceptanceState {
  readonly schemaVersion: 1;
  readonly target: AcceptanceTarget;
  readonly clientName: string;
  readonly tokenizer: string;
  readonly tokenizerExact: boolean;
  readonly firstResponse: string;
  readonly firstResponseDigest: string;
  readonly phase: 'first_process_completed' | 'second_process_completed';
  readonly secondResponseDigest?: string;
  readonly sourceTokens?: number;
  readonly primaryTokens?: number;
  readonly lifecycle?: string;
}

const scriptPath = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const target = readTarget();
  const stateArgument = readArgument('--state');
  const workerPhase = readArgument('--worker');
  if (workerPhase !== undefined) {
    if (stateArgument === undefined || (workerPhase !== '1' && workerPhase !== '2')) {
      throw new Error('model_restart_acceptance_worker_arguments_invalid');
    }
    await runWorker(target, stateArgument, workerPhase);
    return;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ariadne-model-restart-'));
  const statePath = path.join(temporaryRoot, 'state.json');
  try {
    await spawnWorker(target, statePath, '1');
    await spawnWorker(target, statePath, '2');
    const state = await readState(statePath);
    if (state.phase !== 'second_process_completed') {
      throw new Error('model_restart_acceptance_incomplete');
    }
    console.log(JSON.stringify({
      passed: true,
      target: state.target,
      clientName: state.clientName,
      tokenizer: state.tokenizer,
      tokenizerExact: state.tokenizerExact,
      crossProcessRestart: true,
      sourceTokens: state.sourceTokens,
      primaryTokens: state.primaryTokens,
      lifecycle: state.lifecycle,
      firstResponseDigest: state.firstResponseDigest,
      secondResponseDigest: state.secondResponseDigest
    }));
  } finally {
    const resolved = path.resolve(temporaryRoot);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
      throw new Error('model_restart_acceptance_temp_containment_failed');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function runWorker(
  target: AcceptanceTarget,
  statePath: string,
  phase: '1' | '2'
): Promise<void> {
  const owned = await openClient(target);
  try {
    if (phase === '1') {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Reply with one short sentence.' },
        { role: 'user', content: 'State that this is restart acceptance phase one.' }
      ];
      const counted = await owned.client.tokenCounter.countRequest({ messages });
      assertTokenizer(target, counted);
      const response = await owned.client.chat({ messages, maxTokens: 64, temperature: 0 });
      if (response.content.trim().length === 0) {
        throw new Error('model_restart_acceptance_first_response_empty');
      }
      await writeState(statePath, {
        schemaVersion: 1,
        target,
        clientName: owned.client.name,
        tokenizer: counted.tokenizer,
        tokenizerExact: counted.exact,
        firstResponse: response.content,
        firstResponseDigest: digest(response.content),
        phase: 'first_process_completed'
      });
      return;
    }

    const previous = await readState(statePath);
    if (previous.target !== target || previous.clientName !== owned.client.name) {
      throw new Error('model_restart_acceptance_binding_changed');
    }
    const planned = await prepareLongContextProjection(owned.client, previous);
    const response = await owned.client.chat({
      messages: toChatMessages(planned.primaryMessages),
      maxTokens: 64,
      temperature: 0
    });
    if (response.content.trim().length === 0) {
      throw new Error('model_restart_acceptance_second_response_empty');
    }
    const context = planned.modelContext as Readonly<Record<string, unknown>>;
    const meter = context.tokenMeter as Readonly<Record<string, unknown>>;
    if (
      meter.projectionTokenizer !== previous.tokenizer
      || meter.projectionTokenizerExact !== previous.tokenizerExact
    ) throw new Error('model_restart_acceptance_tokenizer_changed');
    await writeState(statePath, {
      ...previous,
      phase: 'second_process_completed',
      secondResponseDigest: digest(response.content),
      sourceTokens: Number(context.sourceEstimatedTokens),
      primaryTokens: Number(context.primaryEstimatedTokens),
      lifecycle: String(context.lifecycle)
    });
  } finally {
    await owned.close();
  }
}

async function prepareLongContextProjection(
  client: ModelClient,
  previous: RestartAcceptanceState
) {
  const capacity = {
    contextWindowTokens: client.contextWindowTokens ?? 32_768,
    maxOutputTokens: Math.min(1_024, Math.floor((client.contextWindowTokens ?? 32_768) / 8))
  };
  const pinned = [exactMessage('system', 'Continue the durable acceptance conversation concisely.')];
  const groups: V3ModelContextGroup[] = [{
    kind: 'conversation',
    messages: [
      exactMessage('user', 'State that this is restart acceptance phase one.'),
      exactMessage('assistant', previous.firstResponse)
    ]
  }];
  let sourceCount = await countExact(client, [...pinned, ...groups.flatMap((group) => group.messages)]);
  for (let index = 0; sourceCount.tokens <= Math.floor(capacity.contextWindowTokens * 0.82); index += 1) {
    if (index >= 256) throw new Error('model_restart_acceptance_pressure_unreachable');
    groups.push({
      kind: 'conversation',
      messages: [exactMessage(
        index % 2 === 0 ? 'user' : 'assistant',
        `Durable history ${String(index)} ${'context '.repeat(96)}`
      )]
    });
    sourceCount = await countExact(
      client,
      [...pinned, ...groups.flatMap((group) => group.messages)]
    );
  }
  groups.push({
    kind: 'conversation',
    messages: [exactMessage(
      'user',
      `The prior response digest was ${previous.firstResponseDigest}. Confirm phase two in one sentence.`
    )]
  });
  sourceCount = await countExact(client, [...pinned, ...groups.flatMap((group) => group.messages)]);
  const plan = planV3LongContext({
    pinnedMessages: pinned,
    groups,
    capacity,
    requestHeaderDigest: digest('ariadne.model-restart-acceptance.v1'),
    sourceTokenCount: sourceCount
  });
  const primary = await countExact(client, plan.primaryMessages);
  const recovery = plan.overflowRecoveryMessages === null
    ? null
    : await countExact(client, plan.overflowRecoveryMessages);
  return admitV3TokenizedProjections({ plan, capacity, primary, recovery });
}

async function countExact(
  client: ModelClient,
  messages: readonly ExactAgentModelInferenceMessage[]
): Promise<TokenCount> {
  const counted = await client.tokenCounter.countRequest({ messages: toChatMessages(messages) });
  assertTokenizer(client.location, counted);
  return counted;
}

function assertTokenizer(target: AcceptanceTarget, counted: TokenCount): void {
  if (!Number.isSafeInteger(counted.tokens) || counted.tokens < 1 || counted.tokenizer.length === 0) {
    throw new Error('model_restart_acceptance_tokenizer_invalid');
  }
  if (target === 'local' && (!counted.exact || counted.method !== 'model_tokenizer')) {
    throw new Error('model_restart_acceptance_local_tokenizer_not_exact');
  }
}

async function openClient(target: AcceptanceTarget): Promise<{
  readonly client: ModelClient;
  readonly close: () => Promise<void>;
}> {
  const loaded = loadConfig();
  if (target === 'local') {
    const service = new LocalModelService({
      directory: loaded.modelsDirectory,
      autoDiscover: loaded.config.models.autoDiscover,
      watch: false,
      maxLoadedModels: 1,
      idleUnloadMs: loaded.config.models.idleUnloadMs,
      reservedClientNames: loaded.config.models.clients.map((client) => client.name)
    });
    const requested = process.env.ARIADNE_ACCEPT_LOCAL_MODEL;
    const client = service.clients().find((candidate) => requested === undefined || candidate.name === requested);
    if (client === undefined || !await client.isAvailable()) {
      await service.stop();
      throw new Error('local_model_restart_acceptance_model_unavailable');
    }
    return { client, close: () => service.stop() };
  }

  const requested = process.env.ARIADNE_ACCEPT_REMOTE_MODEL;
  if (requested === undefined || requested.length === 0) {
    throw new Error('remote_model_restart_acceptance_requires_ARIADNE_ACCEPT_REMOTE_MODEL');
  }
  const config = loaded.config.models.clients.find((candidate) => candidate.name === requested);
  if (config === undefined || config.kind !== 'api') {
    throw new Error('remote_model_restart_acceptance_binding_unavailable');
  }
  const credentialEnvironment = config.apiKeyEnv;
  if (credentialEnvironment === undefined || (process.env[credentialEnvironment] ?? '').length === 0) {
    throw new Error(
      `remote_model_restart_acceptance_missing_credential:${credentialEnvironment ?? 'unconfigured'}`
    );
  }
  const client = createModelClient(config);
  if (!await client.isAvailable()) throw new Error('remote_model_restart_acceptance_provider_unavailable');
  return { client, close: async () => undefined };
}

function exactMessage(
  role: 'system' | 'user' | 'assistant',
  text: string
): ExactAgentModelInferenceMessage {
  return { role, content: [{ type: 'text', text }] };
}

function toChatMessages(messages: readonly ExactAgentModelInferenceMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => block.type === 'text' ? block.text : '').join('')
  }));
}

async function spawnWorker(
  target: AcceptanceTarget,
  statePath: string,
  phase: '1' | '2'
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      scriptPath,
      '--target',
      target,
      '--state',
      statePath,
      '--worker',
      phase
    ], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`model_restart_acceptance_worker_failed:${String(code)}:${signal ?? 'none'}`));
    });
  });
}

async function readState(statePath: string): Promise<RestartAcceptanceState> {
  const value = JSON.parse(await readFile(statePath, 'utf8')) as RestartAcceptanceState;
  if (value.schemaVersion !== 1 || value.firstResponseDigest !== digest(value.firstResponse)) {
    throw new Error('model_restart_acceptance_state_invalid');
  }
  return value;
}

async function writeState(statePath: string, value: RestartAcceptanceState): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, statePath);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function readTarget(): AcceptanceTarget {
  const value = readArgument('--target');
  if (value === 'local' || value === 'remote') return value;
  throw new Error('model_restart_acceptance_requires_target');
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
