import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { AgentLiveWorkService } from '../../control/resources/AgentLiveWorkService.js';
import {
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredStringProperty,
  requireWorkspace,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';
import {
  acceptedLiveWorkInput,
  liveWorkJobSnapshot,
  liveWorkJsonValue,
  liveWorkOwner,
  rejectedLiveWorkInput
} from './LiveWorkAgentToolSupport.js';

const MAX_STDIN_TEXT_LENGTH = 32 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_WAIT_MS = 60_000;
const MAX_TERMINAL_DIMENSION = 1_000;

export function createLiveWorkControlAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    jobListRegistration(roots, liveWork),
    jobOutputRegistration(roots, liveWork),
    jobWriteRegistration(roots, liveWork),
    jobResizeRegistration(roots, liveWork),
    jobSignalRegistration(roots, liveWork),
    jobKillRegistration(roots, liveWork),
    jobWaitRegistration(roots, liveWork)
  ];
}

function jobListRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_list',
    model: {
      description: 'List live-work jobs owned by the current Agent Run.',
      guidance: ['Use returned capability flags before sending input, resizing, or signaling a job.']
    },
    presentation: { kind: 'terminal', label: '列出运行中任务', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({}, []),
    outputSchema: { type: 'object' },
    validate: emptyObject,
    execute: async (_input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        const owner = liveWorkOwner(context);
        return succeeded(liveWorkJsonValue({
          jobs: liveWork.list(owner).map(liveWorkJobSnapshot),
          completedNotifications: liveWork.claimUnreportedCompletions(owner).map(liveWorkJobSnapshot)
        }));
      } catch (error) {
        return failed('workspace_job_list_failed', error);
      }
    }
  });
}

function jobOutputRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_output',
    model: {
      description: 'Read bounded UTF-8 output from an owned live-work job using a stable byte cursor.',
      guidance: ['Continue from nextCursor; treat truncated=true as explicit loss of older retained output.']
    },
    presentation: { kind: 'terminal', label: '读取任务输出', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({
      jobId: { type: 'string', description: 'Owned job id returned by a live-work producer.' },
      cursor: { type: 'integer', minimum: 0, description: 'Next unread UTF-8 byte cursor.' },
      maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES }
    }, ['jobId']),
    outputSchema: { type: 'object' },
    validate: validateJobOutput,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        const output = liveWork.read(
          liveWorkOwner(context),
          requiredStringProperty(input, 'jobId'),
          integerProperty(input, 'cursor') ?? 0,
          integerProperty(input, 'maxBytes') ?? MAX_READ_BYTES
        );
        return succeeded(liveWorkJsonValue({
          jobId: output.snapshot.id,
          status: output.snapshot.status,
          chunks: output.chunks.map((chunk) => ({
            cursor: chunk.cursor,
            channel: chunk.channel,
            text: chunk.text
          })),
          nextCursor: output.nextCursor,
          truncatedBeforeCursor: output.truncatedBeforeCursor
        }));
      } catch (error) {
        return failed('workspace_job_output_failed', error);
      }
    }
  });
}

function jobWriteRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_write',
    model: {
      description: 'Send UTF-8 input to an owned interactive live-work job.',
      guidance: ['Use only when job_list reports input capability.']
    },
    presentation: { kind: 'terminal', label: '写入任务输入', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_mutate',
    inputSchema: objectSchema({
      jobId: { type: 'string', description: 'Owned live-work job id with input capability.' },
      text: { type: 'string', description: 'UTF-8 text written to the job.' },
      submit: { type: 'boolean', description: 'Submit the input. Defaults to true.' }
    }, ['jobId', 'text']),
    outputSchema: { type: 'object' },
    validate: validateWrite,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        const owner = liveWorkOwner(context);
        const jobId = requiredStringProperty(input, 'jobId');
        const work = liveWork.get(owner, jobId);
        const text = requiredStringProperty(input, 'text', true);
        const submittedText = (booleanProperty(input, 'submit') ?? true)
          ? `${text}${work.kind === 'terminal' ? '\r' : '\n'}`
          : text;
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(await liveWork.write(
          owner,
          jobId,
          submittedText
        ))));
      } catch (error) {
        return failed('workspace_job_write_failed', error);
      }
    }
  });
}

function jobResizeRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_resize',
    model: {
      description: 'Resize an owned pseudoterminal live-work job.',
      guidance: ['Use only when the job reports resize capability.']
    },
    presentation: { kind: 'terminal', label: '调整终端尺寸', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_mutate',
    inputSchema: objectSchema({
      jobId: { type: 'string', description: 'Owned terminal job id.' },
      columns: { type: 'integer', minimum: 1, maximum: MAX_TERMINAL_DIMENSION },
      rows: { type: 'integer', minimum: 1, maximum: MAX_TERMINAL_DIMENSION }
    }, ['columns', 'jobId', 'rows']),
    outputSchema: { type: 'object' },
    validate: validateResize,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(await liveWork.resize(
          liveWorkOwner(context),
          requiredStringProperty(input, 'jobId'),
          {
            columns: requiredIntegerProperty(input, 'columns'),
            rows: requiredIntegerProperty(input, 'rows')
          }
        ))));
      } catch (error) {
        return failed('workspace_job_resize_failed', error);
      }
    }
  });
}

function jobSignalRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_signal',
    model: {
      description: 'Send one supported signal to an owned live-work job.',
      guidance: ['Use only when the job reports signal capability; observe or wait for the resulting state.']
    },
    presentation: { kind: 'terminal', label: '向任务发送信号', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_mutate',
    inputSchema: objectSchema({
      jobId: { type: 'string', description: 'Owned live-work job id with signal capability.' },
      signal: { type: 'string', enum: ['interrupt', 'terminate', 'kill'] }
    }, ['jobId', 'signal']),
    outputSchema: { type: 'object' },
    validate: validateSignal,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        const signal = requiredStringProperty(input, 'signal');
        if (signal !== 'interrupt' && signal !== 'terminate' && signal !== 'kill') {
          throw new Error('workspace_job_signal_invalid');
        }
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(await liveWork.signal(
          liveWorkOwner(context),
          requiredStringProperty(input, 'jobId'),
          signal
        ))));
      } catch (error) {
        return failed('workspace_job_signal_failed', error);
      }
    }
  });
}

function jobKillRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_kill',
    model: {
      description: 'Terminate and close one owned live-work job.',
      guidance: ['Use only when graceful completion or a supported signal is not appropriate.']
    },
    presentation: { kind: 'terminal', label: '终止运行中任务', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_close',
    inputSchema: objectSchema({ jobId: { type: 'string' } }, ['jobId']),
    outputSchema: { type: 'object' },
    validate: validateJobIdOnly,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'write');
        context.signal.throwIfAborted();
        return succeeded(liveWorkJsonValue(liveWorkJobSnapshot(await liveWork.kill(
          liveWorkOwner(context),
          requiredStringProperty(input, 'jobId')
        ))));
      } catch (error) {
        return failed('workspace_job_kill_failed', error);
      }
    }
  });
}

function jobWaitRegistration(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'workspace.job_wait',
    model: {
      description: 'Wait for an owned live-work job to finish or for a bounded timeout.',
      guidance: ['A timeout is an observation result, not proof that the job stopped.']
    },
    presentation: { kind: 'terminal', label: '等待任务完成', resultVisibility: 'protected' },
    capabilityIds: ['workspace.shell'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    lifecycleSemantics: 'resource_observe',
    inputSchema: objectSchema({
      jobId: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS }
    }, ['jobId']),
    outputSchema: { type: 'object' },
    validate: validateJobWait,
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'read');
        const result = await liveWork.wait(
          liveWorkOwner(context),
          requiredStringProperty(input, 'jobId'),
          integerProperty(input, 'timeoutMs') ?? 30_000
        );
        return succeeded(liveWorkJsonValue({
          completed: result.completed,
          job: liveWorkJobSnapshot(result.snapshot)
        }));
      } catch (error) {
        return failed('workspace_job_wait_failed', error);
      }
    }
  });
}

function validateJobOutput(input: AgentToolJsonValue) {
  return isRecord(input)
    && !hasUnknownKeys(input, ['jobId', 'cursor', 'maxBytes'])
    && validJobId(input.jobId)
    && optionalInteger(input.cursor, 0, Number.MAX_SAFE_INTEGER)
    && optionalInteger(input.maxBytes, 1, MAX_READ_BYTES)
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function validateWrite(input: AgentToolJsonValue) {
  return isRecord(input)
    && !hasUnknownKeys(input, ['jobId', 'text', 'submit'])
    && validJobId(input.jobId)
    && typeof input.text === 'string'
    && Buffer.byteLength(input.text, 'utf8') <= MAX_STDIN_TEXT_LENGTH
    && (input.submit === undefined || typeof input.submit === 'boolean')
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function validateResize(input: AgentToolJsonValue) {
  return isRecord(input)
    && !hasUnknownKeys(input, ['jobId', 'columns', 'rows'])
    && validJobId(input.jobId)
    && requiredInteger(input.columns, 1, MAX_TERMINAL_DIMENSION)
    && requiredInteger(input.rows, 1, MAX_TERMINAL_DIMENSION)
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function validateSignal(input: AgentToolJsonValue) {
  return isRecord(input)
    && !hasUnknownKeys(input, ['jobId', 'signal'])
    && validJobId(input.jobId)
    && (input.signal === 'interrupt' || input.signal === 'terminate' || input.signal === 'kill')
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function validateJobIdOnly(input: AgentToolJsonValue) {
  return isRecord(input) && !hasUnknownKeys(input, ['jobId']) && validJobId(input.jobId)
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function validateJobWait(input: AgentToolJsonValue) {
  return isRecord(input)
    && !hasUnknownKeys(input, ['jobId', 'timeoutMs'])
    && validJobId(input.jobId)
    && optionalInteger(input.timeoutMs, 0, MAX_WAIT_MS)
    ? acceptedLiveWorkInput(input) : rejectedLiveWorkInput();
}

function emptyObject(input: AgentToolJsonValue) {
  return isRecord(input) && Object.keys(input).length === 0
    ? acceptedLiveWorkInput({}) : rejectedLiveWorkInput();
}

function validJobId(value: AgentToolJsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalInteger(value: AgentToolJsonValue | undefined, min: number, max: number): boolean {
  return value === undefined || requiredInteger(value, min, max);
}

function requiredInteger(value: AgentToolJsonValue | undefined, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function integerProperty(input: AgentToolJsonValue, key: string): number | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error('tool_input_invalid');
  return value;
}

function requiredIntegerProperty(input: AgentToolJsonValue, key: string): number {
  const value = integerProperty(input, key);
  if (value === undefined) throw new Error('tool_input_invalid');
  return value;
}

function booleanProperty(input: AgentToolJsonValue, key: string): boolean | undefined {
  if (!isRecord(input)) throw new Error('tool_input_invalid');
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('tool_input_invalid');
  return value;
}
