export type AgentInstructionExecutionMode = 'agent' | 'plan' | 'chat';

export interface AgentInstructionAssemblyRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly executionMode: AgentInstructionExecutionMode;
}

export type AgentInstructionScope =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'mode'; readonly mode: AgentInstructionExecutionMode };

export interface AgentInstructionContribution {
  readonly blockId: string;
  readonly scope: AgentInstructionScope;
  readonly content: string;
}

export interface AgentInstructionContributorDescriptor {
  readonly contributorId: string;
  readonly version: string;
  readonly order: number;
  readonly executionModes: readonly AgentInstructionExecutionMode[];
}

export interface AgentInstructionContributor {
  readonly descriptor: AgentInstructionContributorDescriptor;
  contribute(
    request: AgentInstructionAssemblyRequest,
    signal: AbortSignal
  ): Promise<readonly AgentInstructionContribution[]>;
}

export interface AgentInstructionBlock {
  readonly blockId: string;
  readonly contributorId: string;
  readonly contributorVersion: string;
  readonly order: number;
  readonly scope: AgentInstructionScope;
  readonly revision: string;
  readonly content: string;
}

export interface AgentInstructionAssemblySnapshot {
  readonly snapshotVersion: 1;
  readonly complete: true;
  readonly subject: AgentInstructionAssemblyRequest;
  readonly blocks: readonly AgentInstructionBlock[];
}

export interface AgentInstructionAssemblyService {
  assemble(
    request: AgentInstructionAssemblyRequest,
    signal: AbortSignal
  ): Promise<AgentInstructionAssemblySnapshot>;
}
