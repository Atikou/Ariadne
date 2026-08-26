import { SqliteAgentRunUnitOfWork } from '../../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { AgentRunExecutionIntent } from '../../src/control/ports/AgentRunExecutionStarter.js';

const dataRoot = process.argv[2];
if (dataRoot === undefined || dataRoot.length === 0) {
  throw new Error('execution_intent_fixture_data_root_required');
}

const unit = new SqliteAgentRunUnitOfWork(dataRoot);
const intent: AgentRunExecutionIntent = {
  kind: 'agent.execution.start',
  executionIntentId: 'execution-intent-1',
  sourceOutboxMessageId: 'conversation-linked-outbox-1',
  sagaId: 'conversation-saga-1',
  sessionId: 'execution-session',
  workspaceId: 'execution-workspace',
  objectiveMessageId: 'execution-objective-message',
  objectiveMessageVersion: 1,
  objectiveDigest: `sha256:${'b'.repeat(64)}`,
  runRequestId: 'execution-run-request',
  runId: 'execution-run',
  admittedRunVersion: 1,
  occurredAt: '2030-01-01T00:00:00.000Z'
};

try {
  const receipt = await unit.startExecutionIntent(
    intent,
    new AbortController().signal
  );
  process.send?.({ type: 'intent_committed', receipt });
  setInterval(() => undefined, 60_000);
} catch (error) {
  process.send?.({
    type: 'fixture_error',
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}
