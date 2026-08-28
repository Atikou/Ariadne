import { createServer } from 'node:https';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const options = parseArguments(process.argv.slice(2));
const model = requireOption(options, 'model');
const statePath = requireOption(options, 'state');
const readyPath = requireOption(options, 'ready');
const pfxPath = requireOption(options, 'pfx');
const passphrase = requireOption(options, 'passphrase');
const workspaceId = requireOption(options, 'workspace-id');

const scenarios = [
  'direct',
  'read',
  'write_allow',
  'write_deny',
  'inbox',
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
  if (scenario === null || body?.model !== model) {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unknown_smoke_scenario' }));
    return;
  }

  const continuationPayload = readContinuationPayload(messages);
  const inboxContinuation = scenario === 'inbox' && hasInboxContinuation(messages);
  const continuation = continuationPayload !== null || inboxContinuation;
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
    // Keep the first inference observably active while Electron, the public
    // projection and React all cross their real asynchronous boundaries. The
    // test must enqueue during execution, not race a two-second mock response.
    await delay(10_000);
  }
  if (scenario === 'crash_projection' && continuation) {
    await delay(750);
  }

  const directive = createDirective(scenario, continuationPayload, inboxContinuation);
  const payload = JSON.stringify({
    model,
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify({
          protocol: 'ariadne.agent-directive.v3',
          directive
        })
      }
    }]
  });
  settled = true;
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  response.end(payload);
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

function createDirective(scenario, continuationPayload, inboxContinuation) {
  if (inboxContinuation) {
    return { kind: 'respond', content: 'ARIADNE_SMOKE_INBOX_FINAL' };
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
    case 'inbox':
      return { kind: 'respond', content: 'ARIADNE_SMOKE_INBOX_FIRST' };
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
    const content = messages[index]?.content;
    if (typeof content !== 'string' || !content.includes('ariadne.agent-effect-results.v3')) continue;
    try {
      const parsed = JSON.parse(content);
      return parsed?.protocol === 'ariadne.agent-effect-results.v3' ? parsed : null;
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
    return result.result?.path === 'fixtures/read.txt'
      && result.result?.content === 'ARIADNE_SMOKE_READ_FIXTURE';
  }
  if (scenario === 'write_allow') {
    return result.result?.path === 'results/allow.txt';
  }
  if (scenario === 'crash_projection') {
    return result.result?.path === 'results/projection-once.txt';
  }
  return scenario === 'crash_effect';
}

function writeDirective(toolCallId, path, content) {
  return {
    kind: 'invoke_tools',
    invocations: [{
      toolCallId,
      toolName: 'workspace.write_file',
      input: { path, content },
      scope: [workspaceId]
    }]
  };
}

function identifyScenario(messages) {
  const text = messages
    .map((message) => typeof message?.content === 'string' ? message.content : '')
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
