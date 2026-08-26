import type {
  AgentEffectExecutionOutcome,
  AgentPinnedToolIdentity,
  AgentToolJsonValue
} from '@ariadne/agent-core';

export interface AgentToolExecutionContext {
  readonly runId: string;
  readonly effectId: string;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly signal: AbortSignal;
}

export type AgentToolInputValidationResult =
  | {
      readonly status: 'accepted';
      readonly input: AgentToolJsonValue;
    }
  | {
      readonly status: 'rejected';
    };

/**
 * Data-only authority document for one executable Tool contract. The trusted
 * compiler hashes the canonical form of every field; callers never provide a
 * contract pin directly.
 */
export interface AgentToolContractDocumentV1 {
  readonly documentVersion: 1;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly providerId: string;
  readonly inputSchema: AgentToolJsonValue;
  readonly outputSchema: AgentToolJsonValue;
  readonly capabilityIds: readonly string[];
  readonly requiredWorkspaceAccess: 'read' | 'write';
  readonly permission: {
    readonly authority: 'run_grant';
    readonly approval: 'never' | 'required';
  };
  readonly scopeSemantics:
    | 'none'
    | 'all_requested_workspace_scopes_must_be_granted';
  readonly resourceSemantics:
    | 'none'
    | 'workspace_relative_path'
    | 'workspace_resource_id'
    | 'external_resource_id';
  readonly sideEffect: 'none' | 'read' | 'write' | 'external';
  readonly idempotency:
    | 'not_idempotent'
    | 'idempotency_key_required';
  readonly recovery:
    | 'none'
    | 'retry_same_idempotency_key'
    | 'reconcile_before_retry';
  readonly timeoutMs: number;
  readonly implementationArtifacts: {
    readonly providerDigest: string;
    readonly normalizerDigest: string;
    readonly preparedValidatorDigest: string;
    readonly executeDigest: string;
  };
}

/** Actual bytes used as digest evidence; no Function.toString authority. */
export interface AgentToolImplementationArtifactBytesV1 {
  readonly provider: Uint8Array;
  readonly normalizer: Uint8Array;
  readonly preparedValidator: Uint8Array;
  readonly execute: Uint8Array;
}

/**
 * Executable callbacks paired with their load/build artifact bytes. The
 * trusted compiler verifies those bytes against the contract document before
 * retaining the callbacks in an immutable snapshot.
 */
export interface AgentToolExecutableImplementationV1 {
  readonly artifacts: AgentToolImplementationArtifactBytesV1;
  normalizeAndValidate(input: AgentToolJsonValue): AgentToolInputValidationResult;
  /** Revalidates canonical prepared data without invoking the normalizer. */
  validatePrepared(input: AgentToolJsonValue): AgentToolInputValidationResult;
  execute(
    input: AgentToolJsonValue,
    context: AgentToolExecutionContext
  ): Promise<AgentEffectExecutionOutcome>;
}

/** Compiler-produced immutable Catalog contract consumed across composition seams. */
export interface AgentToolCatalogSnapshotEntry {
  readonly document: AgentToolContractDocumentV1;
  readonly tool: AgentPinnedToolIdentity;
  readonly executable: Pick<
    AgentToolExecutableImplementationV1,
    'normalizeAndValidate' | 'validatePrepared' | 'execute'
  >;
}

export interface AgentToolCatalogSnapshot {
  readonly catalogId: string;
  readonly revision: number;
  readonly catalogDigest: string;
  readonly entries: readonly AgentToolCatalogSnapshotEntry[];
}
