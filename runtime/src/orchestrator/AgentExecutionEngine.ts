import type {
  AgentExecutionEngine,
  AgentExecutionEngineFactory,
} from "./AgentExecutionEngineContracts.js";
import type { AgentExecutionEngineKind } from "./AgentExecutionIdentity.js";
import type { AgentLoopCreationRequest } from "./AgentLoopCreationContracts.js";

export type {
  AgentExecutionEngine,
  AgentExecutionEngineFactory,
} from "./AgentExecutionEngineContracts.js";
export type { AgentExecutionEngineKind } from "./AgentExecutionIdentity.js";

/**
 * Execution selection boundary. Permission, checkpoint, resume, Timeline and UI
 * code depend on this registry rather than on a concrete Loop implementation.
 */
export class AgentExecutionEngineRegistry {
  private readonly factories = new Map<AgentExecutionEngineKind, AgentExecutionEngineFactory>();

  constructor(
    factories: readonly AgentExecutionEngineFactory[],
    readonly defaultKind: AgentExecutionEngineKind,
  ) {
    for (const factory of factories) {
      if (this.factories.has(factory.kind)) {
        throw new Error(`Duplicate Agent execution engine: ${factory.kind}`);
      }
      this.factories.set(factory.kind, factory);
    }
    if (!this.factories.has(defaultKind)) {
      throw new Error(`Default Agent execution engine is not registered: ${defaultKind}`);
    }
  }

  create(
    request: AgentLoopCreationRequest,
    kind: AgentExecutionEngineKind = this.defaultKind,
  ): AgentExecutionEngine {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`Agent execution engine is unavailable: ${kind}`);
    return factory.create(request);
  }
}
