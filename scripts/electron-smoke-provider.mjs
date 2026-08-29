import { createServer } from 'node:https';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const options = parseArguments(process.argv.slice(2));
const model = requireOption(options, 'model');
const statePath = requireOption(options, 'state');
const readyPath = requireOption(options, 'ready');
const pfxPath = requireOption(options, 'pfx');
const passphrase = requireOption(options, 'passphrase');
const workspaceId = requireOption(options, 'workspace-id');
const agentDatabasePath = requireOption(options, 'agent-db');

const scenarios = [
  'direct',
  'image',
  'read',
  'write_allow',
  'write_deny',
  'inbox',
  'question',
  'crash_question',
  'cancel',
  'crash_inference',
  'crash_effect',
  'crash_projection'
];
const state = {
  protocol: 'ariadne-electron-smoke-provider.v1',
  requests: 0,
  responses: 0,
  aborted: 0,
  scenarios: Object.fromEntries(scenarios.map((name) => [name, {
    requests: 0,
    responses: 0,
    aborted: 0,
    initialRequests: 0,
    continuationRequests: 0
  }]))
};

const server = createServer({
  pfx: readFileSync(pfxPath),
  passphrase
}, async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const scenario = identifyScenario(messages);
  if (
    scenario === null
    || body?.model !== model
    || (scenario === 'image' && !hasValidImageInput(messages))
  ) {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unknown_smoke_scenario' }));
    return;
  }

  const continuationPayload = readContinuationPayload(messages);
  const inboxContinuation = scenario === 'inbox' && hasInboxContinuation(messages);
  const questionContinuation = (
    scenario === 'question' || scenario === 'crash_question'
  ) && hasQuestionContinuation(messages);
  const continuation = continuationPayload !== null || inboxContinuation || questionContinuation;
  const scenarioState = state.scenarios[scenario];
  state.requests += 1;
  scenarioState.requests += 1;
  if (continuation) scenarioState.continuationRequests += 1;
  else scenarioState.initialRequests += 1;
  persistState();

  let settled = false;
  request.once('aborted', recordAbort);
  response.once('close', () => {
    if (!settled && !response.writableEnded) recordAbort();
  });

  if (scenario === 'cancel' || scenario === 'crash_inference') return;
  if (scenario === 'inbox' && !continuation) {
    // End the first response only after the real Renderer -> Main -> Runtime
    // path has durably enqueued the exact input. A fixed delay makes this test
    // depend on projection/React scheduling rather than the authority fact it
    // is intended to verify.
    if (!await waitForInboxInput(
      agentDatabasePath,
      'ARIADNE_SMOKE_INBOX_INPUT',
      60_000
    )) {
      settled = true;
      response.writeHead(504, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'smoke_inbox_enqueue_timeout' }));
      return;
    }
  }
  if (scenario === 'crash_projection' && continuation) {
    await delay(750);
  }

  const directive = createDirective(
    scenario,
    continuationPayload,
    inboxContinuation,
    questionContinuation
  );
  const directivePayload = JSON.stringify({
    protocol: 'ariadne.agent-directive.v3',
    directive
  });
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  writeSseData(response, {
    model,
    choices: [{ delta: { reasoning_content: 'ARIADNE_SMOKE_STREAM_REASONING' } }]
  });
  await delay(750);
  writeSseData(response, {
    model,
    choices: [{ delta: { content: directivePayload } }]
  });
  writeSseData(response, {
    model,
    choices: [{ delta: {}, finish_reason: 'stop' }]
  });
  response.end('data: [DONE]\n\n');
  settled = true;
  state.responses += 1;
  scenarioState.responses += 1;
  persistState();

  function recordAbort() {
    if (settled) return;
    settled = true;
    state.aborted += 1;
    scenarioState.aborted += 1;
    persistState();
  }
});

server.listen(0, 'localhost', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('smoke_provider_address_unavailable');
  }
  persistState();
  writeJsonAtomic(readyPath, {
    protocol: 'ariadne-electron-smoke-provider-ready.v1',
    baseUrl: `https://localhost:${String(address.port)}/v1`,
    model,
    pid: process.pid
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function createDirective(
  scenario,
  continuationPayload,
  inboxContinuation,
  questionContinuation
) {
  if (inboxContinuation) {
    return { kind: 'respond', content: 'ARIADNE_SMOKE_INBOX_FINAL' };
  }
  if (questionContinuation) {
    return {
      kind: 'respond',
      content: scenario === 'crash_question'
        ? 'ARIADNE_SMOKE_CRASH_USER_QUESTION_COMPLETED'
        : 'ARIADNE_SMOKE_USER_QUESTION_COMPLETED'
    };
  }
  if (continuationPayload !== null) {
    if (!validContinuation(scenario, continuationPayload)) {
      return { kind: 'respond', content: 'ARIADNE_SMOKE_EFFECT_VALIDATION_FAILED' };
    }
    const content = {
      read: 'ARIADNE_SMOKE_READ_OK',
      write_allow: 'ARIADNE_SMOKE_WRITE_ALLOW_OK',
      crash_effect: 'ARIADNE_SMOKE_CRASH_EFFECT_UNEXPECTED_CONTINUATION',
      crash_projection: 'ARIADNE_SMOKE_CRASH_PROJECTION_OK'
    }[scenario];
    if (content === undefined) throw new Error(`unexpected_continuation:${scenario}`);
    return { kind: 'respond', content };
  }
  switch (scenario) {
    case 'direct':
      return { kind: 'respond', content: 'ARIADNE_SMOKE_DIRECT_OK' };
    case 'image':
      return { kind: 'respond', content: 'ARIADNE_SMOKE_IMAGE_OK' };
    case 'inbox':
      return { kind: 'respond', content: 'ARIADNE_SMOKE_INBOX_FIRST' };
    case 'question':
    case 'crash_question':
      return {
        kind: 'ask_user',
        question: {
          prompt: 'Which execution path should Ariadne use for this smoke?',
          options: [
            {
              optionId: 'local',
              label: 'Local only',
              description: 'Continue on this machine.'
            },
            {
              optionId: 'remote',
              label: 'Remote host',
              description: 'Continue on a remote machine.'
            }
          ]
        }
      };
    case 'read':
      return {
        kind: 'invoke_tools',
        invocations: [{
          toolCallId: 'smoke-read-call',
          toolName: 'workspace.read_file',
          input: { path: 'fixtures/read.txt' },
          scope: [workspaceId]
        }]
      };
    case 'write_allow':
      return writeDirective('smoke-write-allow-call', 'results/allow.txt', 'ARIADNE_SMOKE_WRITE_ALLOW_CONTENT');
    case 'write_deny':
      return writeDirective('smoke-write-deny-call', 'results/deny.txt', 'ARIADNE_SMOKE_WRITE_DENY_CONTENT');
    case 'crash_effect':
      return {
        kind: 'invoke_tools',
        invocations: [{
          toolCallId: 'smoke-crash-effect-call',
          toolName: 'browser.wait',
          input: { milliseconds: 30_000 },
          scope: [workspaceId]
        }]
      };
    case 'crash_projection':
      return writeDirective(
        'smoke-crash-projection-call',
        'results/projection-once.txt',
        'ARIADNE_SMOKE_PROJECTION_SIDE_EFFECT_ONCE'
      );
    default:
      throw new Error(`unexpected_responding_scenario:${scenario}`);
  }
}

function hasInboxContinuation(messages) {
  return messages.some((message) => (
    message?.role === 'assistant'
    && message?.content === 'ARIADNE_SMOKE_INBOX_FIRST'
  )) && messages.some((message) => (
    message?.role === 'user'
    && message?.content === 'ARIADNE_SMOKE_INBOX_INPUT'
  ));
}

function readContinuationPayload(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const resultMessage = messages[index];
    if (
      resultMessage?.role !== 'tool'
      || typeof resultMessage.tool_call_id !== 'string'
      || typeof resultMessage.content !== 'string'
    ) continue;
    const assistantMessage = messages.slice(0, index).findLast((message) => (
      message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.some((call) => call?.id === resultMessage.tool_call_id)
    ));
    if (assistantMessage === undefined) return null;
    try {
      const parsed = JSON.parse(resultMessage.content);
      if (
        parsed === null
        || typeof parsed !== 'object'
        || !['succeeded', 'failed', 'cancelled'].includes(parsed.status)
        || !Object.hasOwn(parsed, 'output')
      ) return null;
      return {
        results: [{
          toolCallId: resultMessage.tool_call_id,
          status: parsed.status,
          output: parsed.output
        }]
      };
    } catch {
      return null;
    }
  }
  return null;
}

function validContinuation(scenario, payload) {
  if (!Array.isArray(payload?.results) || payload.results.length !== 1) return false;
  const result = payload.results[0];
  if (result?.status !== 'succeeded') return false;
  if (scenario === 'read') {
    return result.output?.path === 'fixtures/read.txt'
      && result.output?.content === 'ARIADNE_SMOKE_READ_FIXTURE'
      && /^workspace-file-v1:[a-f0-9]{64}$/.test(result.output?.version ?? '');
  }
  if (scenario === 'write_allow') {
    return result.output?.path === 'results/allow.txt'
      && result.output?.operation === 'created'
      && /^workspace-file-v1:[a-f0-9]{64}$/.test(result.output?.version ?? '');
  }
  if (scenario === 'crash_projection') {
    return result.output?.path === 'results/projection-once.txt';
  }
  return scenario === 'crash_effect';
}

function writeDirective(toolCallId, path, content) {
  return {
    kind: 'invoke_tools',
    invocations: [{
      toolCallId,
      toolName: 'workspace.write_file',
      input: { path, content, mode: 'create_if_absent' },
      scope: [workspaceId]
    }]
  };
}

function identifyScenario(messages) {
  const text = messages
    .flatMap((message) => typeof message?.content === 'string'
      ? [message.content]
      : Array.isArray(message?.content)
        ? message.content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
        : [])
    .join('\n');
  let identified = null;
  let identifiedAt = -1;
  for (const scenario of scenarios) {
    const index = text.lastIndexOf(`ariadne-smoke:${scenario}`);
    if (index > identifiedAt) {
      identified = scenario;
      identifiedAt = index;
    }
  }
  return identified;
}

function hasQuestionContinuation(messages) {
  const renderedQuestion = [
    'Which execution path should Ariadne use for this smoke?',
    '- Local only: Continue on this machine.',
    '- Remote host: Continue on a remote machine.'
  ].join('\n');
  return messages.some((message) => (
    message?.role === 'assistant'
    && message?.content === renderedQuestion
  )) && messages.some((message) => (
    message?.role === 'user'
    && message?.content === 'local: Local only'
  ));
}

function hasValidImageInput(messages) {
  return messages.some((message) => (
    message?.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) => (
      block?.type === 'image_url'
      && typeof block.image_url?.url === 'string'
      && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(
        block.image_url.url
      )
    ))
  ));
}

async function waitForInboxInput(path, content, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      let database = null;
      try {
        database = new DatabaseSync(path, { readOnly: true });
        const observed = database.prepare(`
          SELECT 1 AS observed
            FROM agent_v3_outbox
           WHERE json_extract(event_json, '$.payload.type')='inbox.input_enqueued'
             AND json_extract(event_json, '$.payload.input.content')=?
           ORDER BY cursor DESC
           LIMIT 1
        `).get(content)?.observed === 1;
        if (observed) return true;
      } catch {
        // Runtime owns writes with zero busy timeout. A transient read/open
        // failure is retried from a fresh read-only connection.
      } finally {
        database?.close();
      }
    }
    await delay(10);
  }
  return false;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1_048_576) {
        reject(new Error('request_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.once('error', reject);
  });
}

function persistState() {
  // Windows readers can transiently hold the destination without delete-share,
  // which makes rename-based replacement fail with EPERM. The observer treats
  // a partial JSON read as retryable, so state snapshots use direct replacement.
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temporary, target);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid_arguments');
    result[key.slice(2)] = value;
  }
  return result;
}

function requireOption(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing_option:${key}`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeSseData(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
