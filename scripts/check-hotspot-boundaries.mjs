import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const boundaries = [
  {
    file: 'runtime/src/composition/DefaultAgentControlRuntimeFactory.ts',
    maxLines: 500,
    required: [
      './AgentControlPublicCommandRouter.js',
      './AgentControlRuntimeCompositionSupport.js',
      './agent-entity/components/persistence/AgentPersistenceComponent.js',
      './agent-entity/components/projection/AgentProjectionComponent.js'
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
      /\bPublicProjectionWakePublisher\b/
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
    maxLines: 310,
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
    maxLines: 700,
    required: [
      './agent-entity/command-owners/AgentPublicCommandOwnerTable.js',
      './agent-entity/command-owners/AgentPublicCommandOwners.js'
    ],
    forbidden: [
      /switch\s*\(\s*envelope\.command\.kind\s*\)/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/command-owners/AgentPublicCommandOwnerTable.ts',
    maxLines: 90,
    forbidden: [
      /ConversationAuthorityService/,
      /AgentDecisionAuthorityService/,
      /Sqlite\w+Store/,
      /Sqlite\w+UnitOfWork/
    ]
  },
  {
    file: 'runtime/src/composition/agent-entity/command-owners/AgentPublicCommandOwners.ts',
    maxLines: 180,
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
      './runtime-capabilities/RuntimeCapabilityManifestCompiler.js'
    ],
    forbidden: [
      /defineRuntimeCapabilityProvider/,
      /compileTrustedAgentToolCatalog/
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
