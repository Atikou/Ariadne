import { RunPolicyManager } from "./RunPolicyManager.js";
import type { ResolveRunPolicyInput, RunPolicy } from "./RunPolicyContracts.js";
import type { AgentRunMode } from "./RunPolicyPrimitives.js";

export type { ResolveRunPolicyInput, RunPolicy } from "./RunPolicyContracts.js";
export type { AgentRunMode } from "./RunPolicyPrimitives.js";

export async function resolveRunPolicyAsync(input: ResolveRunPolicyInput = {}): Promise<RunPolicy> {
  return new RunPolicyManager().resolveAsync(input);
}

export function resolveRunPolicy(input: ResolveRunPolicyInput = {}): RunPolicy {
  return new RunPolicyManager().resolve(input);
}

export function parseRunMode(mode: string | undefined): AgentRunMode | undefined {
  return new RunPolicyManager().parseMode(mode);
}

export { RunPolicyManager } from "./RunPolicyManager.js";
