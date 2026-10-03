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
  'stream_recovery',
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
  if (body?.model !== model) {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unknown_smoke_model' }));
    return;
  }
  const probeOutput = createQualificationProbeOutput(body, messages);
  if (probeOutput !== null) {
    await writeNativeSseResponse(response, probeOutput);
    return;
  }
  const scenario = identifyScenario(messages);
  if (
    scenario === null
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

  const output = createNativeOutput(
    body,
    scenario,
    continuationPayload,
    inboxContinuation,
    questionContinuation
  );
  await writeNativeSseResponse(response, output, scenario === 'stream_recovery' ? 2_000 : 750,
    scenario === 'stream_recovery' ? 4 : 2);
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

function createNativeOutput(
  body,
  scenario,
  continuationPayload,
  inboxContinuation,
  questionContinuation
) {
  if (inboxContinuation) {
    return textOutput('ARIADNE_SMOKE_INBOX_FINAL');
  }
  if (questionContinuation) {
    return textOutput(scenario === 'crash_question'
      ? 'ARIADNE_SMOKE_CRASH_USER_QUESTION_COMPLETED'
      : 'ARIADNE_SMOKE_USER_QUESTION_COMPLETED');
  }
  if (continuationPayload !== null) {
    if (!validContinuation(scenario, continuationPayload)) {
      return textOutput('ARIADNE_SMOKE_EFFECT_VALIDATION_FAILED');
    }
    const content = {
      read: 'ARIADNE_SMOKE_READ_OK',
      write_allow: 'ARIADNE_SMOKE_WRITE_ALLOW_OK',
      crash_effect: 'ARIADNE_SMOKE_CRASH_EFFECT_UNEXPECTED_CONTINUATION',
      crash_projection: 'ARIADNE_SMOKE_CRASH_PROJECTION_OK'
    }[scenario];
    if (content === undefined) throw new Error(`unexpected_continuation:${scenario}`);
    return textOutput(content);
  }
  switch (scenario) {
    case 'direct':
      return textOutput('ARIADNE_SMOKE_DIRECT_OK');
    case 'stream_recovery':
      return textOutput('ARIADNE_SMOKE_STREAM_RECOVERY_OK');
    case 'image':
      return textOutput('ARIADNE_SMOKE_IMAGE_OK');
    case 'inbox':
      return textOutput('ARIADNE_SMOKE_INBOX_FIRST');
    case 'question':
    case 'crash_question':
      return toolOutput('smoke-question-call', findToolName(body, {
        name: 'ariadne_control_ask_user'
      }), {
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
      });
    case 'read':
      return toolOutput('smoke-read-call', findToolName(body, {
        description: 'Read one bounded UTF-8 Workspace file'
      }), {
        input: { path: 'fixtures/read.txt' },
        scope: [workspaceId]
      });
    case 'write_allow':
      return writeOutput(
        body,
        'smoke-write-allow-call',
        'results/allow.txt',
        'ARIADNE_SMOKE_WRITE_ALLOW_CONTENT'
      );
    case 'write_deny':
      return writeOutput(
        body,
        'smoke-write-deny-call',
        'results/deny.txt',
        'ARIADNE_SMOKE_WRITE_DENY_CONTENT'
      );
    case 'crash_effect':
      return toolOutput('smoke-crash-effect-call', findToolName(body, {
        description: 'Wait for a bounded interval while the current browser page continues processing.'
      }), {
        input: { milliseconds: 30_000 },
        scope: [workspaceId]
      });
    case 'crash_projection':
      return writeOutput(
        body,
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

function writeOutput(body, toolCallId, path, content) {
  return toolOutput(toolCallId, findToolName(body, {
    description: 'Create a new Workspace file or replace an observed file'
  }), {
    input: { path, content, mode: 'create_if_absent' },
    scope: [workspaceId]
  });
}

function createQualificationProbeOutput(body, messages) {
  if (identifyScenario(messages) !== null) return null;
  const toolNames = requestTools(body).map((tool) => tool.function.name);
  const text = messageText(messages);
  if (toolNames.length === 0 && hasValidImageInput(messages)) {
    return textOutput('IMAGE_OK');
  }
  if (toolNames.includes('probe_calculate')) {
    if (messages.some((message) => message?.role === 'tool')) return textOutput('5');
    if (text.includes('Answer directly. Do not use a function.')) return textOutput('READY');
    return toolOutput('qualification-calculate-call', 'probe_calculate', { left: 2, right: 3 });
  }
  if (toolNames.length === 1 && toolNames[0] === 'ariadne_control_ask_user') {
    return toolOutput('qualification-ask-user-call', 'ariadne_control_ask_user', {
      question: { prompt: 'Which color do you prefer?' }
    });
  }
  if (toolNames.length === 1 && toolNames[0] === 'ariadne_control_propose_plan') {
    return toolOutput('qualification-plan-call', 'ariadne_control_propose_plan', {
      plan: {
        summary: 'Inspect a document.',
        impactSummary: 'Read-only document inspection.',
        steps: [{
          title: 'Inspect document',
          summary: 'Read and inspect the selected document.',
          impact: 'read_only'
        }]
      }
    });
  }
  return toolNames.length === 0 && text.includes('Reply with the single word READY.')
    ? textOutput('READY')
    : null;
}

function requestTools(body) {
  if (!Array.isArray(body?.tools)) return [];
  return body.tools.filter((tool) => (
    tool?.type === 'function'
    && typeof tool.function?.name === 'string'
    && typeof tool.function?.description === 'string'
  ));
}

function findToolName(body, selector) {
  const selected = requestTools(body).find((tool) => (
    (selector.name === undefined || tool.function.name === selector.name)
    && (
      selector.description === undefined
      || tool.function.description.includes(selector.description)
    )
  ));
  if (selected === undefined) throw new Error('required_native_tool_not_advertised');
  return selected.function.name;
}

function messageText(messages) {
  return messages
    .flatMap((message) => typeof message?.content === 'string'
      ? [message.content]
      : Array.isArray(message?.content)
        ? message.content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
        : [])
    .join('\n');
}

function textOutput(content) {
  return { kind: 'text', content };
}

function toolOutput(toolCallId, providerToolName, input) {
  return { kind: 'tool_call', toolCallId, providerToolName, input };
}

async function writeNativeSseResponse(response, output, responseDelayMs = 0, fragmentCount = 2) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  writeSseData(response, {
    model,
    choices: [{ delta: { reasoning_content: 'ARIADNE_SMOKE_STREAM_REASONING' } }]
  });
  if (responseDelayMs > 0) await delay(responseDelayMs);
  if (output.kind === 'text') {
    const splitAt = responseDelayMs > 0 && output.content.length > 1
      ? Math.ceil(output.content.length / fragmentCount)
      : output.content.length;
    writeSseData(response, {
      model,
      choices: [{ delta: { content: output.content.slice(0, splitAt) } }]
    });
    for (let offset = splitAt; offset < output.content.length; offset += splitAt) {
      await delay(responseDelayMs);
      writeSseData(response, {
        model,
        choices: [{ delta: { content: output.content.slice(offset, offset + splitAt) } }]
      });
    }
    writeSseData(response, {
      model,
      choices: [{ delta: {}, finish_reason: 'stop' }]
    });
  } else {
    writeSseData(response, {
      model,
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: output.toolCallId,
            type: 'function',
            function: {
              name: output.providerToolName,
              arguments: JSON.stringify(output.input)
            }
          }]
        }
      }]
    });
    writeSseData(response, {
      model,
      choices: [{ delta: {}, finish_reason: 'tool_calls' }]
    });
  }
  response.end('data: [DONE]\n\n');
}

function identifyScenario(messages) {
  const text = messageText(messages);
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
