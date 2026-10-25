import { createServer } from 'node:https';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MODEL_QUALITY_CASES } from '../runtime/dist/model/capability/ModelQualityContracts.js';
import { createSmokeJsonSnapshotWriter } from './smoke-json-snapshot.mjs';

const options = parseArguments(process.argv.slice(2));
const model = requireOption(options, 'model');
const statePath = requireOption(options, 'state');
const stateWriter = createSmokeJsonSnapshotWriter(statePath);
const readyPath = requireOption(options, 'ready');
const pfxPath = requireOption(options, 'pfx');
const passphrase = requireOption(options, 'passphrase');
const workspaceId = requireOption(options, 'workspace-id');
const agentDatabasePath = requireOption(options, 'agent-db');

const scenarios = [
  'direct',
  'quality_benchmark',
  'quality_route',
  'document_edit_conflict',
  'stream_recovery',
  'image',
  'read',
  'write_allow',
  'write_deny',
  'inbox',
  'question',
  'notification_plan',
  'notification_failure',
  'crash_question',
  'cancel',
  'cancel_follow_up',
  'cancel_required_parent',
  'cancel_required_child',
  'cancel_effect',
  'schedule_complete',
  'schedule_cancel',
  'memory_stage',
  'memory_read',
  'memory_forget',
  'workflow_complete',
  'workflow_context_seed',
  'workflow_context_later',
  'workflow_cancel',
  'goal_context_seed',
  'goal_context_later',
  'goal_plan',
  'goal_task_first',
  'goal_task_repair',
  'goal_pause_plan',
  'goal_pause_task',
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
  const qualityTask=MODEL_QUALITY_CASES.find(task=>messages.length===2 && messageText([messages[1]])===task.prompt);
  if(qualityTask) {
    if(requestTools(body).length!==0 || body.temperature!==0 || (body.max_tokens??body.max_completion_tokens)!==512)
      throw new Error('quality_smoke_synthetic_envelope_invalid');
    const trace=state.scenarios.quality_benchmark;state.requests++;trace.requests++;trace.initialRequests++;persistState();
    await writeNativeSseResponse(response,textOutput(JSON.stringify(qualityTask.expected)));
    state.responses++;trace.responses++;persistState();return;
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
  const planContinuation = scenario === 'notification_plan' && messages.some(message => message?.role === 'user'
    && typeof message.content === 'string' && /^Plan .+ version 1 \(sha256:[a-f0-9]{64}\) was approved\. Continue with this exact plan\. Tool permissions remain separately enforced\.$/u.test(message.content));
  const continuation = continuationPayload !== null || inboxContinuation || questionContinuation || planContinuation;
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
  if (scenario === 'cancel_required_child') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(`data: ${JSON.stringify({ model, choices: [{ delta: {
      content: 'ARIADNE_SMOKE_REQUIRED_CHILD_PARTIAL'
    } }] })}\n\n`);
    return;
  }
  if (scenario === 'cancel_follow_up' && continuation) {
    if (!validContinuation('read', continuationPayload)) {
      throw new Error('cancel_follow_up_effect_evidence_invalid');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(`data: ${JSON.stringify({ model, choices: [{ delta: {
      content: 'ARIADNE_SMOKE_CANCEL_FOLLOW_UP_PARTIAL'
    } }] })}\n\n`);
    // The real second inference stays in flight until its owning scheduler aborts it.
    return;
  }
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
  if (scenario.startsWith('goal_')) return createGoalOutput(body, scenario, continuationPayload);
  if (scenario.startsWith('memory_')) return createMemoryOutput(body, scenario, continuationPayload);
  if (scenario === 'document_edit_conflict') return createDocumentOutput(body, continuationPayload);
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
    case 'notification_failure':
      // A complete native response that violates the original Agent directive
      // contract. The production engine, rather than a seeded Core row, fails it.
      return textOutput('   ');
    case 'notification_plan':
      if (messageText(body.messages).includes('was approved. Continue with this exact plan.')) {
        const proposal = body.messages.find(message => message?.role === 'assistant'
          && typeof message.content === 'string' && message.content.startsWith('Plan proposal:\n'));
        if (!proposal) throw new Error('notification_plan_protected_payload_missing');
        const plan = JSON.parse(proposal.content.slice('Plan proposal:\n'.length));
        if (plan.publicPresentation?.summary !== '【验收夹具】检查受控文档'
          || plan.publicPresentation?.steps?.[0]?.impact !== 'read_only') throw new Error('notification_plan_payload_drifted');
        return textOutput('ARIADNE_SMOKE_PLAN_APPROVED_COMPLETED');
      }
      return toolOutput('notification-plan-call', findToolName(body, { name: 'ariadne_control_propose_plan' }), {
        plan: { summary: '【验收夹具】检查受控文档', impactSummary: 'Read-only inspection of the isolated fixture.',
          steps: [{ title: 'Inspect fixture', summary: 'Read the isolated document.', impact: 'read_only' }] }
      });
    case 'cancel_required_parent':
      return toolOutput('smoke-delegate-cancel-call', findToolName(body, { name: 'ariadne_control_delegate_subagent' }), {
        subagent: { description: 'Cancellation acceptance child', prompt: 'ariadne-smoke:cancel_required_child', mode: 'one_shot' }
      });
    case 'direct':
      return textOutput('ARIADNE_SMOKE_DIRECT_OK');
    case 'quality_route':
      return textOutput('ARIADNE_SMOKE_QUALITY_ROUTE_OK');
    case 'schedule_complete':
      return textOutput('ARIADNE_SMOKE_SCHEDULE_ACTUAL_RESULT');
    case 'workflow_context_seed':
      return textOutput('ARIADNE_SMOKE_WORKFLOW_CONTEXT_SEEDED');
    case 'workflow_context_later':
      return textOutput('ARIADNE_SMOKE_WORKFLOW_CONTEXT_CHANGED');
    case 'workflow_complete': {
      const text = messageText(body.messages);
      const task = [...text.matchAll(/ariadne-smoke:workflow_complete task ([012])/gu)].at(-1)?.[1];
      const dependencyCount = [...text.matchAll(/ARIADNE_SMOKE_WORKFLOW_TASK_COMPLETED_[01]/gu)].length;
      if (!text.includes('ARIADNE_SMOKE_WORKFLOW_FROZEN_REQUIREMENT')
        || text.includes('ARIADNE_SMOKE_WORKFLOW_LATER_REQUIREMENT')
        || dependencyCount !== (task === '2' ? 2 : 0)) return textOutput('ARIADNE_SMOKE_WORKFLOW_CONTEXT_INVALID');
      return textOutput(`ARIADNE_SMOKE_WORKFLOW_TASK_COMPLETED_${task}`);
    }
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
    case 'cancel_follow_up':
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
    case 'cancel_effect':
    case 'schedule_cancel':
    case 'workflow_cancel':
      return toolOutput('smoke-cancel-effect-call', findToolName(body, {
        description: 'Wait for a bounded interval while the current browser page continues processing.'
      }), { input: { milliseconds: 6_000 }, scope: [workspaceId] });
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

function createDocumentOutput(body, payload) {
  const path = 'fixtures/editor-crlf.txt';
  const result = payload?.results?.[0];
  if (!result) return toolOutput('document-read', findToolName(body, {
    description: 'Read one bounded UTF-8 Workspace file'
  }), { input: { path }, scope: [workspaceId] });
  if (result.status !== 'succeeded' || result.output?.path !== path
    || !/^workspace-file-v1:[a-f0-9]{64}$/.test(result.output?.version ?? '')) {
    return textOutput('ARIADNE_SMOKE_DOCUMENT_TOOL_INVALID');
  }
  if (result.output.operation === 'replaced') return textOutput('ARIADNE_SMOKE_DOCUMENT_CONFLICT_WRITTEN');
  if (result.output.content !== 'ARIADNE_SMOKE_EDITOR_EDITED\r\n编辑中文\r\n') {
    return textOutput('ARIADNE_SMOKE_DOCUMENT_READ_INVALID');
  }
  return toolOutput('document-replace', findToolName(body, {
    description: 'Create a new Workspace file or replace an observed file'
  }), { input: { path, content: 'ARIADNE_SMOKE_EDITOR_EXTERNAL\r\nexternal中文\r\n',
    mode: 'replace_if_version', expectedVersion: result.output.version }, scope: [workspaceId] });
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
  const lastUser = messages.findLast(message => message?.role === 'user');
  const current = lastUser ? messageText([lastUser]) : '';
  if (current.includes('当前待办：ariadne-smoke:goal_task_first')) return 'goal_task_first';
  if (current.includes('当前待办：ariadne-smoke:goal_task_repair')) return 'goal_task_repair';
  if (current.includes('当前待办：ariadne-smoke:goal_pause_task')) return 'goal_pause_task';
  if (current.startsWith('目标：ariadne-smoke:goal_pause_plan')) return 'goal_pause_plan';
  if (current.startsWith('目标：ariadne-smoke:goal_plan')) return 'goal_plan';
  let identified = null;
  for (const match of messageText(messages).matchAll(/ariadne-smoke:([a-z_]+)/gu)) {
    if (scenarios.includes(match[1])) identified = match[1];
  }
  return identified;
}

function createGoalOutput(body, scenario, continuation) {
  if (scenario === 'goal_context_seed') return textOutput('ARIADNE_SMOKE_GOAL_CONTEXT_SEEDED');
  if (scenario === 'goal_context_later') return textOutput('ARIADNE_SMOKE_GOAL_CONTEXT_CHANGED');
  const text = messageText(body.messages);
  if (!text.includes('ARIADNE_SMOKE_GOAL_FROZEN_REQUIREMENT') || text.includes('ARIADNE_SMOKE_GOAL_LATER_REQUIREMENT')) {
    return textOutput('ARIADNE_SMOKE_GOAL_CONTEXT_INVALID');
  }
  const result = continuation?.results?.[0];
  const record = value => toolOutput('smoke-goal-decision-call', findToolName(body, {
    description: 'Stage one structured plan, verified completion assessment, or blocked decision'
  }), { input: value, scope: [workspaceId] });
  const read = path => toolOutput('smoke-goal-evidence-call', findToolName(body, {
    description: 'Read one bounded UTF-8 Workspace file'
  }), { input: { path }, scope: [workspaceId] });
  if (scenario === 'goal_pause_plan') {
    return result?.status === 'succeeded' && result.output?.staged === true ? textOutput('ARIADNE_SMOKE_GOAL_PAUSE_PLAN_REPORT')
      : record({ decision: 'plan', summary: 'Exercise actual owned cancellation',
        tasks: [{ key: 'wait', title: 'ariadne-smoke:goal_pause_task', dependsOn: [] }] });
  }
  if (scenario === 'goal_pause_task') return toolOutput('smoke-goal-wait-call', findToolName(body, {
    description: 'Wait for a bounded interval while the current browser page continues processing.'
  }), { input: { milliseconds: 6_000 }, scope: [workspaceId] });
  if (!text.includes('ARIADNE_SMOKE_GOAL_FILE_CRITERION')) return textOutput('ARIADNE_SMOKE_GOAL_CRITERIA_MISSING');
  if (scenario === 'goal_task_first') {
    if (!text.includes('ARIADNE_SMOKE_GOAL_INITIAL_PLAN_REPORT')) return textOutput('ARIADNE_SMOKE_GOAL_PLAN_CONTEXT_MISSING');
    return result?.status === 'succeeded' && result.output?.content === 'ARIADNE_SMOKE_READ_FIXTURE'
      ? textOutput('ARIADNE_SMOKE_GOAL_FIRST_RESULT_INCOMPLETE') : read('fixtures/read.txt');
  }
  if (scenario === 'goal_task_repair') {
    if (!text.includes('ARIADNE_SMOKE_GOAL_REPLAN_REPORT')) return textOutput('ARIADNE_SMOKE_GOAL_REPLAN_CONTEXT_MISSING');
    return result?.status === 'succeeded' && result.output?.path === 'results/goal-verified.txt'
      ? textOutput('ARIADNE_SMOKE_GOAL_REPAIRED_RESULT')
      : writeOutput(body, 'smoke-goal-repair-call', 'results/goal-verified.txt', 'ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT');
  }
  const current = messageText([body.messages.findLast(message => message?.role === 'user')]);
  const initial = current.includes('当前阶段：planning');
  const repaired = current.includes('ARIADNE_SMOKE_GOAL_REPAIRED_RESULT');
  if (result?.status === 'succeeded' && result.output?.staged === true) {
    return textOutput(initial ? 'ARIADNE_SMOKE_GOAL_INITIAL_PLAN_REPORT'
      : repaired ? 'ARIADNE_SMOKE_GOAL_VERIFIED_REPORT' : 'ARIADNE_SMOKE_GOAL_REPLAN_REPORT');
  }
  if (initial) return record({ decision: 'plan', summary: 'Inspect actual input before implementing the required artifact',
    tasks: [{ key: 'inspect', title: 'ariadne-smoke:goal_task_first', dependsOn: [] }] });
  if (result === undefined) return read(repaired ? 'results/goal-verified.txt' : 'fixtures/read.txt');
  if (result.status !== 'succeeded') return textOutput('ARIADNE_SMOKE_GOAL_EVIDENCE_FAILED');
  if (!repaired && result.output?.content === 'ARIADNE_SMOKE_READ_FIXTURE') {
    return record({ decision: 'plan', summary: 'First result does not meet the artifact criterion; create and verify the missing artifact',
      tasks: [{ key: 'repair', title: 'ariadne-smoke:goal_task_repair', dependsOn: [] }] });
  }
  if (repaired && result.output?.content === 'ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT'
    && /^workspace-file-v1:[a-f0-9]{64}$/.test(result.output?.version ?? '')) {
    return record({ decision: 'complete', summary: 'Inspected actual produced file in the verification Run', checks: [{ criterion: 0,
      status: 'passed', evidence: 'workspace.read_file returned results/goal-verified.txt with ARIADNE_SMOKE_GOAL_VERIFIED_ARTIFACT and a durable file version.',
      sources: [{ kind: 'tool_result', toolCallId: result.toolCallId }] }] });
  }
  return textOutput('ARIADNE_SMOKE_GOAL_RESULT_INVALID');
}

function createMemoryOutput(body, scenario, continuation) {
  const system = messageText(body.messages.filter(message => message.role === 'system'));
  if (!system.includes('memory.reviewed-context') || !system.includes('ARIADNE_SMOKE_REVIEWED_MEMORY')) return textOutput('ARIADNE_SMOKE_MEMORY_CONTEXT_INVALID');
  const result = continuation?.results?.[0];
  const call = (toolCallId, description, input) => toolOutput(toolCallId, findToolName(body, { description }), { input, scope: [workspaceId] });
  if (scenario === 'memory_stage') {
    if (system.includes('ARIADNE_SMOKE_CANDIDATE_MEMORY')) return textOutput('ARIADNE_SMOKE_MEMORY_UNREVIEWED_CONTEXT');
    if (result === undefined) return call('memory-recall-call', 'Recall relevant active, reviewed, unexpired memories', { query: 'ARIADNE_SMOKE_REVIEWED_MEMORY', limit: 5 });
    if (result.status !== 'succeeded') return textOutput('ARIADNE_SMOKE_MEMORY_TOOL_FAILED');
    if (result.output?.kind === 'memory.recall_result' && result.output.hits.some(hit => hit.memory.content.includes('ARIADNE_SMOKE_REVIEWED_MEMORY'))
      && result.output.embedding.capability === 'lexical_approximation') return call('memory-candidate-call', 'Persist one candidate memory for user review', {
        scope: 'workspace', memoryType: 'fact', title: '【验收夹具】Agent 候选记忆', content: 'ARIADNE_SMOKE_CANDIDATE_MEMORY',
        importance: 0.8, confidence: 0.9, sensitivity: 'workspace', retentionUntil: null });
    if (result.output?.kind === 'memory.updated' && result.output.version === 1) return call('memory-read-candidate-call', 'Read one complete memory within the current Run owner scope', { memoryId: result.output.memoryId });
    if (result.output?.kind === 'memory.read_result' && result.output.memory?.status === 'candidate' && result.output.memory.reviewedAt === null
      && result.output.memory.provenance.kind === 'agent' && result.output.memory.content === 'ARIADNE_SMOKE_CANDIDATE_MEMORY') return textOutput('ARIADNE_SMOKE_MEMORY_STAGE_VERIFIED');
    return textOutput('ARIADNE_SMOKE_MEMORY_RESULT_INVALID');
  }
  const lastUser = messageText([body.messages.findLast(message => message.role === 'user')]);
  const memoryId = lastUser.match(/memoryId=([A-Za-z0-9._-]+)/u)?.[1];
  if (!memoryId) return textOutput('ARIADNE_SMOKE_MEMORY_ID_MISSING');
  if ((scenario === 'memory_read') !== system.includes('ARIADNE_SMOKE_EDITED_MEMORY')) return textOutput('ARIADNE_SMOKE_MEMORY_EDIT_CONTEXT_INVALID');
  if (result === undefined) return call('memory-owner-read-call', 'Read one complete memory within the current Run owner scope', { memoryId });
  if (result.status !== 'succeeded' || result.output?.kind !== 'memory.read_result') return textOutput('ARIADNE_SMOKE_MEMORY_READ_FAILED');
  if (scenario === 'memory_forget' && result.output.memory === null) return textOutput('ARIADNE_SMOKE_MEMORY_FORGET_VERIFIED');
  if (scenario === 'memory_read' && result.output.memory?.version === 3 && result.output.memory.content === 'ARIADNE_SMOKE_EDITED_MEMORY'
    && result.output.memory.status === 'active') return textOutput('ARIADNE_SMOKE_MEMORY_READ_VERIFIED');
  return textOutput('ARIADNE_SMOKE_MEMORY_READ_INVALID');
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
            FROM agent_outbox
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
  void stateWriter.write(state).catch(error => {
    console.error('Smoke Provider could not publish its complete state snapshot.', error);
    process.exit(1);
  });
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
