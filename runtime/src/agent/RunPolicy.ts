import { RunPolicyManager } from "./RunPolicyManager.js";
import type { AgentRunMode, ResolveRunPolicyInput, RunPolicy } from "./RunPolicyTypes.js";
export type * from "./RunPolicyTypes.js";

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
