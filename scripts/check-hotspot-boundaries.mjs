import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const boundaries = [
  {
    file: 'runtime/src/composition/DefaultAgentControlRuntimeFactory.ts',
    maxLines: 420,
    required: [
      './AgentControlPublicCommandRouter.js',
      './AgentControlRuntimeCompositionSupport.js',
      './agent-entity/AgentEntityCommandAssembly.js',
      './agent-entity/components/persistence/AgentPersistenceComponent.js',
      './agent-entity/components/projection/AgentProjectionComponent.js',
      './agent-entity/components/execution/AgentExecutionComponent.js'
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
      /\.runWorkScheduler\.start\(/,
      /\.executionScheduler\.start\(/,
      /\.handoffProducer\.start\(/
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
    maxLines: 290,
    required: [
      '../../../../control/run/AgentDecisionAuthorityService.js'
    ],
    forbidden: [
      /ConversationAuthorityService/,
      /SqliteConversationRunHandoffUnitOfWork/,
      /ConversationSessionPublicCommandHandler/
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
      './runtime-capabilities/ProductionRuntimeCapabilityProviders.js',
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
    maxLines: 30,
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
    file: 'runtime/src/composition/runtime-capabilities/RuntimeCapabilityProvider.ts',
    maxLines: 80
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/ProductionRuntimeCapabilityContext.ts',
    maxLines: 110
  },
  {
    file: 'runtime/src/composition/runtime-capabilities/ProductionRuntimeCapabilityProviders.ts',
    maxLines: 140,
    forbidden: [/compileTrustedAgentToolCatalog/]
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
