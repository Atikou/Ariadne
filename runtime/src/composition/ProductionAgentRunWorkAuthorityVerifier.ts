import {
  assertValidAgentRun,
  sameAgentPinnedToolIdentity,
  type AgentRun
} from '@ariadne/agent-core';

import type {
  AgentAdmissionToolCatalogProvider
} from '../control/ports/AgentAdmissionAuthority.js';
import type { AgentRunWorkAuthorityVerifier } from './AgentRunWorkScheduler.js';

export interface ExactAgentModelBindingAvailability {
  hasExactBinding(binding: AgentRun['binding']['model']): boolean;
}

/** Startup/dispatch preflight for immutable model and Tool authorities. */
export class ProductionAgentRunWorkAuthorityVerifier
implements AgentRunWorkAuthorityVerifier {
  public constructor(
    private readonly models: ExactAgentModelBindingAvailability,
    private readonly catalogs: AgentAdmissionToolCatalogProvider
  ) {}

  public async assertRestorable(run: AgentRun, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    assertValidAgentRun(run);
    if (!this.models.hasExactBinding(run.binding.model)) {
      throw unavailable('model_binding_unavailable');
    }
    const reference = {
      referenceVersion: 1 as const,
      catalogId: run.binding.toolCatalog.catalogId,
      revision: run.binding.toolCatalog.revision,
      digest: run.binding.toolCatalog.digest
    };
    const catalog = await this.catalogs.readToolCatalog(reference, signal);
    signal.throwIfAborted();
    if (catalog === null) throw unavailable('tool_catalog_unavailable');
    let availableTools;
    try {
      availableTools = catalog.resolveAdmissionTools(run.binding);
    } catch (cause) {
      throw unavailable('tool_catalog_binding_drift', cause);
    }
    for (const effect of run.effects) {
      const available = availableTools.find((candidate) => (
        sameAgentPinnedToolIdentity(candidate.tool, effect.tool)
      ));
      if (
        available === undefined
        || effect.capabilityIds.some(
          (capabilityId) => !available.capabilityIds.includes(capabilityId)
        )
      ) {
        throw unavailable('effect_tool_authority_unavailable');
      }
    }
  }
}

export class AgentRunWorkAuthorityUnavailableError extends Error {
  public readonly code = 'AGENT_RUN_WORK_AUTHORITY_UNAVAILABLE';

  public constructor(
    public readonly reason:
      | 'model_binding_unavailable'
      | 'tool_catalog_unavailable'
      | 'tool_catalog_binding_drift'
      | 'effect_tool_authority_unavailable',
    options?: ErrorOptions
  ) {
    super(`Agent Run work authority is unavailable: ${reason}.`, options);
    this.name = 'AgentRunWorkAuthorityUnavailableError';
  }
}

function unavailable(
  reason: AgentRunWorkAuthorityUnavailableError['reason'],
  cause?: unknown
): AgentRunWorkAuthorityUnavailableError {
  return cause === undefined
    ? new AgentRunWorkAuthorityUnavailableError(reason)
    : new AgentRunWorkAuthorityUnavailableError(reason, { cause });
}
