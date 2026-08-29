import type {
  AgentEffectExecutionOutcome,
  AgentPinnedToolIdentity,
  AgentToolJsonValue
} from '@ariadne/agent-core';

export interface AgentProtectedEffectResultReadResult {
  readonly effectId: string;
  readonly toolCallId: string;
  readonly status: 'succeeded' | 'failed';
  readonly digest: string;
  readonly totalBytes: number;
  readonly cursor: number;
  readonly nextCursor: number;
  readonly content: string;
  readonly complete: boolean;
}

/** Owner-scoped access to an already-protected durable Effect result. */
export interface AgentProtectedEffectResultReader {
  read(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly effectId: string;
    readonly cursor: number;
    readonly maxBytes: number;
  }): Promise<AgentProtectedEffectResultReadResult>;
}

export interface AgentToolExecutionServices {
  readonly protectedEffectResults?: AgentProtectedEffectResultReader;
}

export interface AgentToolExecutionContext {
  readonly runId: string;
  readonly effectId: string;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly capabilityIds: readonly string[];
  readonly scope: readonly string[];
  readonly signal: AbortSignal;
  /** Internal execution service; never appears in the data-only Tool contract. */
  readonly protectedEffectResults?: AgentProtectedEffectResultReader;
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
export type AgentToolPresentationKind =
  | 'generic'
  | 'file_read'
  | 'file_search'
  | 'file_change'
  | 'command'
  | 'terminal'
  | 'browser'
  | 'skill'
  | 'external';

export interface AgentToolModelSemanticsV1 {
  /** Trusted provider-visible purpose; never synthesized from the Tool name. */
  readonly description: string;
  /** Short, declarative constraints that improve correct model invocation. */
  readonly guidance: readonly string[];
}

export interface AgentToolPresentationV1 {
  readonly kind: AgentToolPresentationKind;
  /** Public, static activity label. Inputs and results never enter this field. */
  readonly label: string;
  /** Tool results remain in protected Effect storage, not Public Projection. */
  readonly resultVisibility: 'protected';
}

export interface AgentToolContractDocumentV2 {
  readonly documentVersion: 2;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly providerId: string;
  readonly model: AgentToolModelSemanticsV1;
  readonly presentation: AgentToolPresentationV1;
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
  /** Whether one invocation is bounded or controls a Runtime-owned resource. */
  readonly lifecycleSemantics:
    | 'bounded_invocation'
    | 'resource_create'
    | 'resource_observe'
    | 'resource_mutate'
    | 'resource_close';
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
  readonly document: AgentToolContractDocumentV2;
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
