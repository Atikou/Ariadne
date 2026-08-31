import { AgentEffectContinuationController } from '../../../../control/execution/AgentEffectContinuationController.js';
import { AgentInboxContinuationController } from '../../../../control/execution/AgentInboxContinuationController.js';
import { AgentFollowUpInferenceDispatchController } from '../../../../control/execution/AgentFollowUpInferenceDispatchController.js';
import { AgentDelegatedInferenceDispatchController } from '../../../../control/execution/AgentDelegatedInferenceDispatchController.js';
import { AgentChildResultsContinuationController } from '../../../../control/execution/AgentChildResultsContinuationController.js';
import { AgentRunWorkClassifier } from '../../../../control/execution/AgentRunWorkClassifier.js';
import { AgentContinuationBoundaryTerminalizationCoordinator } from '../../../../control/execution/AgentContinuationBoundaryTerminalizationCoordinator.js';
import { AgentRetiredToolCatalogTerminalizationCoordinator } from '../../../../control/execution/AgentRetiredToolCatalogTerminalizationCoordinator.js';
import { AgentStartedWorkRecoveryCoordinator } from '../../../../control/execution/AgentStartedWorkRecoveryCoordinator.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationRunHandoffSagaService } from '../../../../control/conversation/ConversationRunHandoffSagaService.js';
import { ConversationAgentStartFailureProjectionService } from '../../../../control/conversation/ConversationAgentStartFailureProjectionService.js';
import {
  AgentRunExecutionIntentScheduler,
  type AgentRunExecutionIntentRecoveryReporter,
  type AgentRunExecutionIntentSchedulerOptions
} from '../../../AgentRunExecutionIntentScheduler.js';
import {
  AgentRunWorkScheduler,
  type AgentRunWorkSchedulerOptions
} from '../../../AgentRunWorkScheduler.js';
import { ConversationAgentHandoffCoordinator } from '../../../ConversationAgentHandoffCoordinator.js';
import {
  ConversationAgentHandoffProducer,
  type ConversationAgentHandoffProducerOptions
} from '../../../ConversationAgentHandoffProducer.js';
import { ProtectedAgentTerminalAssistantContentResolver } from '../../../ProtectedAgentTerminalAssistantContentResolver.js';
import { ProductionAgentRunWorkAuthorityVerifier } from '../../../ProductionAgentRunWorkAuthorityVerifier.js';
import type { ProductionAgentLifecycleBridge } from '../../../ProductionAgentLifecycleBridge.js';
import {
  AgentSubagentExecutionProviderRouter,
  ordinaryRunSubagentExecutionProvider,
  type AgentSubagentExecutionProvider,
  type ImmutableAgentSubagentExecutionProviderCatalog
} from '../../../AgentSubagentExecutionProviders.js';
import type { AgentInferenceLoopComponentHandle } from '../inference-loop/AgentInferenceLoopComponent.js';
import type { AgentToolExecutionComponentHandle } from '../tool-execution/AgentToolExecutionComponent.js';

export interface AgentExecutionSchedulerComponentInput {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly loop: AgentInferenceLoopComponentHandle;
  readonly tools: AgentToolExecutionComponentHandle;
  readonly lifecycle: ProductionAgentLifecycleBridge;
  readonly subagentProviders: ImmutableAgentSubagentExecutionProviderCatalog;
  readonly injectedSubagentProviders: readonly AgentSubagentExecutionProvider[];
  readonly configuredSubagentProviders: readonly AgentSubagentExecutionProvider[];
  readonly recoveryReporter: AgentRunExecutionIntentRecoveryReporter;
  readonly executionScheduler?: Omit<
    AgentRunExecutionIntentSchedulerOptions,
    'onSettled' | 'startedInitialInferenceRecovery'
  >;
  readonly runWorkScheduler?: Omit<
    AgentRunWorkSchedulerOptions,
    'startedWorkRecovery' | 'authorityVerifier' | 'retiredToolCatalogTerminalizations'
  >;
  readonly handoffProducer?: ConversationAgentHandoffProducerOptions;
}

export interface AgentExecutionSchedulerComponentHandle {
  readonly handoffProducer: ConversationAgentHandoffProducer;
  readonly executionScheduler: AgentRunExecutionIntentScheduler;
  readonly runWorkScheduler: AgentRunWorkScheduler;
}

/** Owns durable execution scheduling, recovery, continuation, and Handoff wake-up. */
export function createAgentExecutionSchedulerComponent(
  input: AgentExecutionSchedulerComponentInput
): AgentExecutionSchedulerComponentHandle {
  const effects = input.tools.createEffectDispatch(input.lifecycle);
  const continuations = new AgentEffectContinuationController(
    input.unitOfWork,
    input.unitOfWork
  );
  const inboxContinuations = new AgentInboxContinuationController(
    input.unitOfWork,
    input.unitOfWork
  );
  const followUps = new AgentFollowUpInferenceDispatchController(
    input.unitOfWork,
    input.loop.inference
  );
  const delegatedInference = new AgentDelegatedInferenceDispatchController(
    input.unitOfWork,
    input.loop.inference
  );
  const subagentRouter = new AgentSubagentExecutionProviderRouter(
    input.unitOfWork,
    [
      ordinaryRunSubagentExecutionProvider(delegatedInference, followUps),
      ...input.injectedSubagentProviders,
      ...input.configuredSubagentProviders
    ]
  );
  const startedWorkRecovery = new AgentStartedWorkRecoveryCoordinator(input.unitOfWork);
  const runWorkScheduler = new AgentRunWorkScheduler(
    input.unitOfWork,
    new AgentRunWorkClassifier(),
    effects,
    continuations,
    inboxContinuations,
    followUps,
    new AgentContinuationBoundaryTerminalizationCoordinator(input.unitOfWork),
    {
      ...input.runWorkScheduler,
      startedWorkRecovery,
      delegatedInference: subagentRouter.delegatedInitial,
      delegatedFollowUps: subagentRouter.followUp,
      childResultsContinuation: new AgentChildResultsContinuationController(
        input.unitOfWork,
        input.unitOfWork,
        new ProtectedAgentTerminalAssistantContentResolver(input.unitOfWork)
      ),
      retiredToolCatalogTerminalizations:
        new AgentRetiredToolCatalogTerminalizationCoordinator(input.unitOfWork),
      authorityVerifier: new ProductionAgentRunWorkAuthorityVerifier(
        input.loop.modelAvailability,
        input.tools.catalogs,
        input.subagentProviders
      )
    }
  );
  const executionScheduler = new AgentRunExecutionIntentScheduler(
    input.unitOfWork,
    input.loop.dispatcher,
    input.recoveryReporter,
    {
      ...input.executionScheduler,
      startedInitialInferenceRecovery: startedWorkRecovery,
      onSettled: () => runWorkScheduler.wake()
    }
  );
  const coordinator = new ConversationAgentHandoffCoordinator(
    input.conversation,
    new ConversationRunHandoffSagaService(input.conversation),
    input.loop.admissions,
    input.unitOfWork,
    {},
    new ConversationAgentStartFailureProjectionService(input.conversation)
  );
  const handoffProducer = new ConversationAgentHandoffProducer({
    drainToFixedPoint: async (request) => {
      const result = await coordinator.drainToFixedPoint(request);
      executionScheduler.wake();
      return result;
    }
  }, input.handoffProducer);

  return Object.freeze({ handoffProducer, executionScheduler, runWorkScheduler });
}
