import {
  AgentInferenceDeterministicFailureError,
  type AgentJsonValue,
  type AgentPinnedToolIdentity,
  type AgentRunBinding,
  type AgentToolJsonValue
} from '@ariadne/agent-core';
import type { AgentInferenceToolContractDescriptorV2 } from '../../control/ports/AgentInferenceToolContracts.js';

export const SUBAGENT_RESULTS_FORMAT = 'ariadne.subagent-results';

export const INTERNAL_DIRECTIVE_PROTOCOL = 'ariadne.agent-directive.v3';

export const MODEL_BINDING_ERROR = 'agent_model_binding_unavailable';

export const MODEL_TEXT_QUALIFICATION_ERROR = 'model_text_qualification_required';

export const MODEL_AGENT_QUALIFICATION_ERROR = 'model_agent_qualification_required';

export const MODEL_PLAN_QUALIFICATION_ERROR = 'model_plan_qualification_required';

export const TOOL_CONTRACT_ERROR = 'agent_tool_contract_unavailable';

export const MODEL_DIRECTIVE_ERROR = 'agent_model_directive_invalid';

export const MODEL_TEXT_RESPONSE_ERROR = 'model_text_response_invalid';

export const MODEL_CONTEXT_ERROR = 'agent_model_context_exhausted';

export const MAX_PROTOCOL_PROMPT_BYTES = 1_048_576;

export const MAX_MODEL_REQUEST_MESSAGES = 1_024;

export const MAX_MODEL_REQUEST_BYTES = 4 * 1_048_576;

export const MAX_MODEL_RESPONSE_CHARACTERS = 1_048_576;

export type AgentToolCatalogBinding = AgentRunBinding['toolCatalog'];

export interface PreparedToolContract {
  readonly tool: AgentPinnedToolIdentity;
  readonly capabilityIds: readonly string[];
  readonly inputSchema: AgentToolJsonValue;
  readonly scopeSemantics: AgentInferenceToolContractDescriptorV2['scopeSemantics'];
  readonly lifecycleSemantics: AgentInferenceToolContractDescriptorV2['lifecycleSemantics'];
  readonly allowedScopes: readonly string[];
  readonly providerToolName: string;
  readonly providerInputSchema: AgentToolJsonValue;
  readonly providerDescription: string;
}

export type NativeControlKind =
  | 'ask_user'
  | 'propose_plan'
  | 'checkpoint'
  | 'complete'
  | 'fail'
  | 'delegate_subagent'
  | 'delegate_subagents';

export const CONTROL_PROVIDER_NAMES = Object.freeze({
  ask_user: 'ariadne_control_ask_user',
  propose_plan: 'ariadne_control_propose_plan',
  checkpoint: 'ariadne_control_checkpoint',
  complete: 'ariadne_control_complete',
  fail: 'ariadne_control_fail',
  delegate_subagent: 'ariadne_control_delegate_subagent',
  delegate_subagents: 'ariadne_control_delegate_subagents'
} satisfies Readonly<Record<NativeControlKind, string>>);

export const CONTROL_KINDS_BY_PROVIDER_NAME = new Map<string, NativeControlKind>(
  Object.entries(CONTROL_PROVIDER_NAMES).map(([kind, name]) => [
    name,
    kind as NativeControlKind
  ])
);

export type ModelDecisionChannel = 'text_response' | 'native_agent';

export function canonicalJson(value: AgentJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, AgentJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key] as AgentJsonValue)}`
  ).join(',')}}`;
}

export function invalidBoundModelHistory(): AgentInferenceDeterministicFailureError {
  return deterministicFailure(
    MODEL_BINDING_ERROR,
    'Effect-result continuation requires exact cumulative causal v3 history.'
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deterministicFailure(
  code: string,
  message: string
): AgentInferenceDeterministicFailureError {
  return new AgentInferenceDeterministicFailureError(code, message);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class StrictDirectiveProtocolError extends Error {}
