import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const boundaries = [
  {
    file: 'app/src/main/speech/speech-gateway.ts',
    maxLines: 400,
    required: ['./entity/speech-port'],
    forbidden: []
  },
  {
    file: 'app/src/main/speech/entity/speech-entity-compiler.ts',
    maxLines: 80,
    required: [
      '@ariadne/component-contracts',
      '../speech-gateway',
      './unavailable-speech-adapter'
    ],
    forbidden: []
  },
  {
    file: 'app/src/renderer/src/core/speech/speech-coordinator.ts',
    maxLines: 200,
    required: ['./speech-agent-bridge'],
    forbidden: [/RuntimeStore/, /MessageFeatureStore/, /RunFeatureStore/, /SessionFeatureStore/]
  },
  {
    file: 'app/src/renderer/src/core/speech/speech-agent-bridge.ts',
    maxLines: 280,
    required: [
      '../runtime/features/message-feature-store',
      '../runtime/features/run-feature-store',
      '../runtime/features/session-feature-store'
    ],
    forbidden: [/RuntimeStore/]
  },
  {
    file: 'runtime/src/composition/DefaultAgentControlRuntimeFactory.ts',
    maxLines: 150,
    required: [
      './AgentControlRuntimeCompositionSupport.js',
      './agent-entity/AgentEntityManifest.js',
      './agent-entity/AgentEntityHandle.js',
      './agent-entity/components/persistence/AgentPersistenceComponent.js'
    ],
    forbidden: [
      /\bexecuteCancelAgentRun\b/,
      /\bexecuteAcceptConversationMessage\b/,
      /\bAgentDecisionAuthorityService\b/,
      /\bConversationAuthorityService\b/,
      /new\s+SqliteAgentRunUnitOfWork\b/,
      /new\s+SqliteConversationRunHandoffUnitOfWork\b/,
      /new\s+SqlitePublicProjectionStore\b/,
      /new\s+SqliteProductivityStore\b/,
      /\bloadAgentPersistenceKeyRing\b/,
      /new\s+AgentRunPublicProjectionPublisher\b/,
      /new\s+ConversationPublicProjectionPublisher\b/,
      /new\s+ModelCatalogPublicProjectionPublisher\b/,
      /\bPublicProjectionWakePublisher\b/,
      /AgentLiveWorkCompletionLifecycle/,
      /AgentControlPublicCommandRouter/,
      /AgentEntityCommandAssembly/,
      /AgentProjectionComponent/,
      /AgentExecutionComponent/,
      /prepareProducerShutdown/,
      /\.runWorkScheduler\.start\(/,
      /\.executionScheduler\.start\(/,
      /\.handoffProducer\.start\(/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/AgentEntityHandle.ts',
    maxLines: 250,
    required: [
      './AgentEntityCommandAssembly.js',
      './AgentEntityManifest.js',
      './components/persistence/AgentPersistenceComponent.js',
      './components/projection/AgentProjectionComponent.js',
      './components/execution/AgentExecutionComponent.js'
    ],
    forbidden: [
      /new\s+SqliteAgentRunUnitOfWork\b/,
      /new\s+SqliteConversationRunHandoffUnitOfWork\b/,
      /createProductionExecutionPipelineFactory/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/AgentEntityManifest.ts',
    maxLines: 60,
    required: [
      './components/persistence/AgentPersistenceComponent.js',
      './components/projection/AgentProjectionComponent.js'
    ],
    forbidden: [
      /new\s+SqliteAgentRunUnitOfWork\b/,
      /new\s+SqliteConversationRunHandoffUnitOfWork\b/,
      /AgentControlPublicCommandRouter/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/execution/AgentExecutionComponent.ts',
    maxLines: 140,
    required: [
      '../../../../control/execution/AgentLiveWorkCompletionLifecycle.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /AgentProjectionComponent/,
      /SqlitePublicProjectionStore/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/subagent/AgentSubagentExecutionComponent.ts',
    maxLines: 180,
    required: [
      '../../../../adapters/subagent/AcpSubagentAgentEngine.js',
      '../../../../adapters/subagent/ProductSubagentAgentEngines.js',
      '../../../AgentSubagentExecutionProviders.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /ConversationAgentHandoffProducer/,
      /AgentRunWorkScheduler/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/tool-execution/AgentToolExecutionComponent.ts',
    maxLines: 180,
    required: [
      '../../../../adapters/tool/ImmutableAgentToolCatalogRegistry.js',
      '../../../../control/execution/ProductionAgentEffectExecutionInputReader.js',
      '../../../../control/resources/ProtectedAgentEffectResultReader.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /ConversationAgentHandoffProducer/,
      /AgentRunWorkScheduler/,
      /AgentInferenceDispatchService/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/inference-loop/AgentInferenceLoopComponent.ts',
    maxLines: 180,
    required: [
      '../../../../adapters/model/ProductionAgentEngineAdapter.js',
      '../../../../control/run/AgentRunAdmissionController.js',
      '../../../ProductionAgentRunAdmissionSnapshotReader.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /ConversationAgentHandoffProducer/,
      /AgentRunWorkScheduler/,
      /AgentEffectDispatchService/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/scheduler/AgentExecutionSchedulerComponent.ts',
    maxLines: 170,
    required: [
      '../../../../control/execution/AgentEffectContinuationController.js',
      '../../../AgentRunExecutionIntentScheduler.js',
      '../../../AgentRunWorkScheduler.js',
      '../../../ConversationAgentHandoffProducer.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /ProductionExactAgentModelInferenceGateway/,
      /ProductionAgentEngineAdapter/,
      /ImmutableAgentToolCatalogRegistry/
    ]
  },
  {
    file: 'runtime/src/composition/ProductionAgentControlExecutionPipelineFactory.ts',
    maxLines: 340,
    required: [
      './agent-entity/components/inference-loop/AgentInferenceLoopComponent.js',
      './agent-entity/components/scheduler/AgentExecutionSchedulerComponent.js',
      './agent-entity/components/subagent/AgentSubagentExecutionComponent.js',
      './agent-entity/components/tool-execution/AgentToolExecutionComponent.js'
    ],
    forbidden: [
      /AcpSubagentAgentEngine/,
      /CodexSubagentAgentEngine/,
      /ClaudeSubagentAgentEngine/,
      /digestAcpSubagentConfiguration/,
      /digestProductSubagentConfiguration/,
      /subagentProviderBootstrapSchema/,
      /ImmutableAgentToolCatalogRegistry/,
      /new\s+ProtectedAgentEffectResultReader\b/,
      /new\s+ProductionAgentEffectExecutionInputReader\b/,
      /new\s+AgentEffectDispatchService\b/,
      /new\s+V3AgentEffectDispatchCheckpointFactory\b/,
      /function\s+assertCatalogAuthorities\b/,
      /function\s+preflightBinding\b/,
      /new\s+ProductionExactAgentModelInferenceGateway\b/,
      /new\s+ProductionAgentEngineAdapter\b/,
      /new\s+AgentRunAdmissionController\b/,
      /new\s+ProductionAgentRunAdmissionSnapshotReader\b/,
      /new\s+AgentInferenceDispatchService\b/,
      /new\s+DefaultAgentInferenceDirectivePlanner\b/,
      /new\s+AgentRunExecutionIntentScheduler\b/,
      /new\s+AgentRunWorkScheduler\b/,
      /new\s+ConversationAgentHandoffProducer\b/,
      /new\s+AgentSubagentExecutionProviderRouter\b/,
      /new\s+AgentStartedWorkRecoveryCoordinator\b/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/persistence/AgentPersistenceComponent.ts',
    maxLines: 270,
    required: [
      '../../../loadAgentPersistenceKeyRing.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /ProductionAgentControlExecutionPipelineFactory/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/projection/AgentProjectionComponent.ts',
    maxLines: 330,
    required: [
      '../../../../projection/AgentRunPublicProjectionPublisher.js',
      '../../../../projection/ConversationPublicProjectionPublisher.js',
      '../../../../projection/ModelCatalogPublicProjectionPublisher.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /new\s+SqliteAgentRunUnitOfWork\b/,
      /new\s+SqliteConversationRunHandoffUnitOfWork\b/,
      /new\s+SqlitePublicProjectionStore\b/
    ]
  },
  {
    file: 'runtime/src/composition/AgentControlPublicCommandRouter.ts',
    maxLines: 40,
    required: [
      './agent-entity/command-owners/AgentPublicCommandOwnerTable.js'
    ],
    forbidden: [
      /switch\s*\(\s*envelope\.command\.kind\s*\)/,
      /AgentEntityCommandAssembly/,
      /ConversationAuthorityService/,
      /ConversationSessionPublicCommandHandler/,
      /ConversationNavigationPublicCommandHandler/,
      /deriveConversationAuthorityId/,
      /AgentDecisionAuthorityService/,
      /AgentRunCommandService/,
      /publicRunMutationFailure/,
      /protectedEffectResultReader/,
      /PUBLIC_PROJECTION_CONTRACT_VERSION/,
      /SqlitePublicProjectionStore/,
      /AgentPublicCommandOwners/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/AgentEntityCommandAssembly.ts',
    maxLines: 130,
    required: [
      './AgentEntityCompiler.js',
      './components/conversation/AgentConversationComponent.js',
      './components/decision/AgentDecisionComponent.js',
      './components/run-control/AgentRunControlComponent.js',
      './components/tool-result-detail/AgentToolResultDetailComponent.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /switch\s*\(\s*envelope\.command\.kind\s*\)/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/AgentEntityCompiler.ts',
    maxLines: 90,
    required: [
      './command-owners/AgentPublicCommandOwnerTable.js'
    ],
    forbidden: [
      /ConversationAuthorityService/,
      /AgentDecisionAuthorityService/,
      /Sqlite\w+Store/,
      /Sqlite\w+UnitOfWork/,
      /conversation\.session\.create/,
      /agent\.run\.cancel/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/tool-result-detail/AgentToolResultDetailComponent.ts',
    maxLines: 105,
    forbidden: [
      /SqliteAgentRunUnitOfWork/,
      /SqliteConversationRunHandoffUnitOfWork/,
      /AgentDecisionAuthorityService/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/run-control/AgentRunControlComponent.ts',
    maxLines: 180,
    required: [
      'AgentRunCommandService'
    ],
    forbidden: [
      /AgentDecisionAuthorityService/,
      /ConversationAuthorityService/,
      /SqliteConversationRunHandoffUnitOfWork/,
      /ConversationSessionPublicCommandHandler/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/decision/AgentDecisionComponent.ts',
    maxLines: 145,
    required: [
      '../../../../control/run/AgentDecisionAuthorityService.js',
      'agent.decision.resolve.v3'
    ],
    forbidden: [
      /AgentRunCommandService/,
      /ConversationAuthorityService/,
      /SqliteConversationRunHandoffUnitOfWork/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/components/conversation/AgentConversationComponent.ts',
    maxLines: 310,
    required: [
      '../../../../control/conversation/ConversationAuthorityService.js',
      '../../../ConversationSessionPublicCommandHandler.js',
      '../../../ConversationNavigationPublicCommandHandler.js'
    ],
    forbidden: [
      /AgentDecisionAuthorityService/,
      /AgentRunCommandService/,
      /SqliteAgentRunUnitOfWork/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/command-owners/AgentPublicCommandOwnerTable.ts',
    maxLines: 110,
    forbidden: [
      /ConversationAuthorityService/,
      /AgentDecisionAuthorityService/,
      /Sqlite\w+Store/,
      /Sqlite\w+UnitOfWork/
    ]
  },
  {
    file: 'runtime/src/composition/ProductionRuntimeCapabilityManifest.ts',
    maxLines: 60,
    required: [
      './runtime-capabilities/ProductionRuntimeCapabilityContext.js',
      './runtime-capabilities/ProductionRuntimeCapabilityCatalog.generated.js',
      './runtime-capabilities/RuntimeCapabilityManifestCompiler.js',
      './agent-entity/AgentCoreComponentCatalog.generated.js'
    ],
    forbidden: [
      /defineRuntimeCapabilityProvider/,
      /compileTrustedAgentToolCatalog/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/AgentCoreComponentCatalog.generated.ts',
    maxLines: 50,
    required: [
      'scripts/generate-agent-component-catalog.mjs',
      './components/command-entity/component.js',
      './components/persistence/component.js'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /Sqlite\w+/,
      /createAgent\w+Component/,
      /ProductionAgentControlExecutionPipelineFactory/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/CoreAgentComponentDefinition.ts',
    maxLines: 40,
    required: [
      '@ariadne/component-contracts'
    ],
    forbidden: [
      /AgentControlPublicCommandRouter/,
      /Sqlite\w+/
    ]
  },
  {
    file: 'scripts/generate-agent-component-catalog.mjs',
    maxLines: 90,
    required: [
      "'runtime', 'src', 'composition', 'agent-entity', 'components'",
      "'component.ts'",
      "process.argv.includes('--check')"
    ]
  },
  {
    file: 'scripts/generate-ui-component-catalog.mjs',
    maxLines: 100,
    required: [
      "'app', 'src', 'renderer', 'src', 'modules'",
      'UiComponentCatalog.generated.ts',
      "process.argv.includes('--check')"
    ],
    forbidden: [
      /import\s*\(/,
      /process\.cwd\(\)/
    ]
  },
  {
    file: 'app/src/renderer/src/core/modules/UiComponentCatalog.generated.ts',
    maxLines: 50,
    required: [
      'generated by scripts/generate-ui-component-catalog.mjs'
    ],
    forbidden: [
      /import\s*\(/,
      /builtinModuleRegistry/
    ]
  },
  {
    file: 'app/src/renderer/src/core/modules/module-contract.ts',
    maxLines: 140,
    required: [
      'ModuleServiceId',
      'ModuleNavigationContribution',
      'ModulePresentation'
    ],
    forbidden: [
      /MODULE_IDS/,
      /builtinModuleRegistry/
    ]
  },
  {
    file: 'app/src/renderer/src/core/modules/module-services-contract.ts',
    maxLines: 55,
    required: [
      'interface ModuleServices',
      'DiagnosticsFeatureStore',
      'ModelFeatureStore'
    ]
  },
  {
    file: 'app/src/renderer/src/core/modules/module-registry.tsx',
    maxLines: 260,
    required: [
      'createDeclaredModuleServices',
      'requiredCapabilities',
      'navigationActions'
    ],
    forbidden: [
      /MODULE_IDS/,
      /builtinModuleRegistry/
    ]
  },
  {
    file: 'app/src/renderer/src/app/App.tsx',
    maxLines: 210,
    required: [
      'registry.navigationActions()',
      'registry.servicesFor'
    ],
    forbidden: [
      /MODULE_IDS/,
      /SettingsDialog/,
      /builtinModuleRegistry/
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/runtime-store.ts',
    maxLines: 635,
    required: [
      'ProjectionCache',
      'ProjectionRuntimeClient',
      'DecisionFeatureStore',
      'HumanSkillFeatureStore',
      'MessageFeatureStore',
      'ProductivityFeatureStore',
      'RunFeatureStore',
      'SessionFeatureStore',
      'ToolResultFeatureStore'
    ],
    forbidden: [
      /async queryProductivity\(/,
      /async createSchedule\(/,
      /async loadProtectedToolResultDetail\(/,
      /async queryHumanSkillCommands\(/,
      /async querySessions\(/,
      /async forkSessionFromMessage\(/,
      /async respondToPermission\(/,
      /async respondToPlan\(/,
      /async sendMessage\(/,
      /async enqueueAgentInput\(/,
      /async sendSubagentInput\(/
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/productivity-feature-store.ts',
    maxLines: 210,
    required: [
      'class ProductivityFeatureStore',
      'RuntimeFeatureCommandGateway'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/human-skill-feature-store.ts',
    maxLines: 80,
    required: ['class HumanSkillFeatureStore']
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/tool-result-feature-store.ts',
    maxLines: 50,
    required: ['class ToolResultFeatureStore']
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/session-feature-store.ts',
    maxLines: 180,
    required: [
      'class SessionFeatureStore',
      'SessionFeatureHost'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/decision-feature-store.ts',
    maxLines: 140,
    required: [
      'class DecisionFeatureStore',
      'DecisionFeatureHost',
      'isExactActionableDecision'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/message-feature-store.ts',
    maxLines: 130,
    required: [
      'class MessageFeatureStore',
      'MessageFeatureHost'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/run-feature-store.ts',
    maxLines: 170,
    required: [
      'class RunFeatureStore',
      'AgentInputDeliveryController'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/agent-input-delivery-controller.ts',
    maxLines: 200,
    required: [
      'class AgentInputDeliveryController',
      'shouldReconcile'
    ]
  },
  {
    file: 'app/src/renderer/src/core/runtime/features/feature-snapshot-store.ts',
    maxLines: 40,
    required: [
      'class FeatureSnapshotStore',
      'useFeatureSnapshot'
    ]
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/RuntimeCapabilityProvider.ts',
    maxLines: 80
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/ProductionRuntimeCapabilityContext.ts',
    maxLines: 110
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/ProductionRuntimeCapabilityCatalog.generated.ts',
    maxLines: 35,
    required: ['scripts/generate-runtime-capability-catalog.mjs'],
    forbidden: [/defineRuntimeCapabilityProvider/]
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/RuntimeCapabilityManifestCompiler.ts',
    maxLines: 300,
    forbidden: [
      /createBrowserAgentToolRegistrations/,
      /createMcpAgentToolRegistrations/,
      /createWorkspaceAgentToolRegistrations/
    ]
  },
  {
    file: 'runtime/src/composition/first-party-tools/BrowserAgentTools.ts',
    maxLines: 500
  },
  {
    file: 'runtime/src/composition/first-party-tools/McpAgentTools.ts',
    maxLines: 220
  },
  {
    file: 'runtime/src/composition/first-party-tools/WorkspaceAgentTools.ts',
    maxLines: 330
  },
  {
    file: 'runtime/src/composition/first-party-tools/FirstPartyAgentToolSupport.ts',
    maxLines: 380
  },
  {
    file: 'runtime/src/adapters/persistence/SqliteAgentRunUnitOfWork.ts',
    maxLines: 5_000,
    required: [
      './SqliteTransactionOwner.js',
      './agent-control/outbox/SqliteAgentRunOutboxStore.js',
      './agent-control/execution-intent/SqliteAgentExecutionIntentStore.js'
    ],
    forbidden: [
      /interface\s+AgentOutboxRow\b/,
      /interface\s+AgentExecutionIntentRow\b/,
      /function\s+claimPendingOutbox\s*\(/,
      /function\s+claimPendingExecutionIntents\s*\(/
    ]
  },
  {
    file: 'runtime/src/adapters/persistence/agent-control/outbox/SqliteAgentRunOutboxStore.ts',
    maxLines: 400
  },
  {
    file: 'runtime/src/adapters/persistence/agent-control/execution-intent/SqliteAgentExecutionIntentStore.ts',
    maxLines: 600
  },
  {
    file: 'runtime/src/adapters/persistence/agent-control/execution-intent/AgentExecutionIntentValidation.ts',
    maxLines: 350
  },
  {
    file: 'runtime/src/adapters/persistence/agent-control/execution-intent/AgentExecutionIntentRowMapper.ts',
    maxLines: 250
  },
  {
    file: 'runtime/src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.ts',
    maxLines: 2_025,
    required: [
      './SqliteTransactionOwner.js',
      './conversation/projection/SqliteConversationProjectionReader.js',
      './conversation/rows/ConversationAuthorityRowMapper.js'
    ],
    forbidden: [
      /function\s+readProjectionRecords\s*\(/,
      /function\s+parseAuthorityCommandRow\s*\(/,
      /interface\s+SessionRow\b/,
      /interface\s+MessageVersionRow\b/,
      /interface\s+AuthorityCommandRow\b/
    ]
  },
  {
    file: 'runtime/src/adapters/persistence/conversation/projection/SqliteConversationProjectionReader.ts',
    maxLines: 220
  },
  {
    file: 'runtime/src/adapters/persistence/conversation/rows/ConversationAuthorityRowMapper.ts',
    maxLines: 350
  }
];

const failures = [];
const measurements = [];

for (const boundary of boundaries) {
  const absolute = path.join(projectRoot, boundary.file);
  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch (error) {
    failures.push(`${boundary.file}: missing or unreadable (${toMessage(error)})`);
    continue;
  }
  const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length;
  measurements.push(`${boundary.file}: ${String(lineCount)}/${String(boundary.maxLines)} lines`);
  if (lineCount > boundary.maxLines) {
    failures.push(
      `${boundary.file}: ${String(lineCount)} lines exceeds boundary ${String(boundary.maxLines)}`
    );
  }
  for (const required of boundary.required ?? []) {
    if (!source.includes(required)) {
      failures.push(`${boundary.file}: required boundary import missing: ${required}`);
    }
  }
  for (const forbidden of boundary.forbidden ?? []) {
    if (forbidden.test(source)) {
      failures.push(`${boundary.file}: centralized responsibility returned (${String(forbidden)})`);
    }
  }
}

process.stdout.write(`Hotspot boundary measurements:\n${measurements.map((line) => `  ${line}`).join('\n')}\n`);
if (failures.length > 0) {
  process.stderr.write(`Hotspot boundary violations:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Hotspot boundary check passed.\n');

function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
