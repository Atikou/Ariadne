import { z } from "zod";

import { CompanionRawOutputStatusSchema } from "../companion/CompanionSessionContracts.js";
import {
  EmbeddedModelRuntimeSchema,
  ModelProviderSchema,
  RoutingStrategySchema,
} from "../config/types.js";
import { TOOL_PERMISSION_VALUES } from "../core/permissions.js";
import { PERMISSION_SCOPE_ORDER } from "../policy/PermissionPolicy.js";
import { SandboxModeSchema } from "../sandbox/SandboxContracts.js";
import type { AppContext } from "./createAppContext.js";

const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().trim().min(1).max(256);
const displayText = z.string().trim().min(1).max(1_024);
const nonNegativeInteger = z.number().int().nonnegative();

export const PUBLIC_CONFIG_BOOLEAN_CAPABILITIES = [
  "traceAudit",
  "contextPersistence",
  "subAgent",
  "scheduler",
  "traceReplay",
  "orchestrator",
  "runsApi",
  "sensitiveDetection",
  "modelPromptRedaction",
  "agentDecisionTrace",
  "strictAgentActionProtocol",
  "agentModelCapabilityGate",
  "measuredAgentProtocolAdmission",
  "completionEvidenceContract",
  "strictHttpBodySchemas",
  "publicErrorSanitization",
  "subAgentSideEffectIsolation",
  "ephemeralCleanupPreview",
  "taskStatusTrace",
  "toolCallTrace",
  "modelUsageTrace",
  "toolErrorCategory",
  "toolStorageRedaction",
  "highRiskConfirmation",
  "multiWorkspaceSandbox",
  "localFirstPrivacyMode",
  "plannerSmartRouting",
  "agentSmartRouting",
  "subAgentSmartRouting",
  "startupRecovery",
  "runReportExport",
  "runReportTimeline",
  "traceReplayFilters",
  "traceSegmentRotation",
  "traceIndex",
  "privacyPurge",
  "storageLifecycle",
  "modelTokenStreaming",
  "routerEvaluatorV3",
  "answerEvaluatorV4",
  "runtimeStatsV6",
  "evalSetRunnerV7",
  "modelCapabilitiesV5",
  "contextAnalyzerV8",
  "promptStrategyBuilderV8",
  "runtimeStatsFeedbackV8",
  "agentPromptStrategyV8",
  "costBudgetManagerV8",
  "modelProfileStoreV8",
  "modelAvailabilityRouting",
  "runPolicyManager",
  "budgetManager",
  "finalizer",
  "toolResultLayers",
  "runStateStore",
  "projectIndex",
  "symbolSearch",
  "toolProviderBoundary",
  "projectSemanticLocate",
  "moduleDependencyGraph",
  "historyFileRecall",
  "projectIndexUpdate",
  "costBudgetPerRun",
  "ruleOnlyRouting",
  "parallelVoteRouting",
  "visualOrchestrationV9",
  "dataLifecycleRetention",
  "permissionScopeResolution",
  "sqliteSchemaMigrations",
  "networkDomainPolicy",
  "structuredToolRisk",
  "companionWorkbenchModule",
] as const;

type PublicBooleanCapability = (typeof PUBLIC_CONFIG_BOOLEAN_CAPABILITIES)[number];
type TrueCapabilityShape = Record<PublicBooleanCapability, z.ZodLiteral<true>>;

const trueCapabilityShape = Object.fromEntries(
  PUBLIC_CONFIG_BOOLEAN_CAPABILITIES.map((key) => [key, z.literal(true)]),
) as TrueCapabilityShape;

const PublicConfigAvailabilitySchema = z
  .object({
    available: z.boolean(),
    checkedAt: timestamp,
  })
  .strict();

export const PublicConfigClientSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("api"),
      name: identifier,
      provider: ModelProviderSchema,
      location: z.literal("remote"),
      model: displayText,
      availability: PublicConfigAvailabilitySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("embedded"),
      name: identifier,
      provider: EmbeddedModelRuntimeSchema,
      location: z.literal("local"),
      model: displayText,
      availability: PublicConfigAvailabilitySchema.optional(),
    })
    .strict(),
]);

export const PublicConfigCapabilitiesSchema = z
  .object({
    ...trueCapabilityShape,
    subAgentWorkspaceIsolation: z
      .object({
        enabled: z.literal(true),
        kind: z.literal("isolated_snapshot"),
        broker: z.literal("session_write_scope"),
        workspaceBinding: z.literal("parent_run_context"),
        orphanRecovery: z.literal("lease_owner_verified"),
        appliedToPrimary: z.literal(false),
        primaryGitMetadataMutation: z.literal(false),
      })
      .strict(),
    processSandbox: z
      .object({
        backend: z.enum(["host-process", "windows-native"]),
        mode: SandboxModeSchema,
        environment: z.literal("allowlist"),
        processTreeTermination: z.literal(true),
        osIsolation: z.boolean(),
        writeScopeProtocol: z.literal(3),
      })
      .strict(),
    codeIntelligence: z
      .object({
        typescriptAst: z.literal(true),
        fallback: z.literal("text"),
      })
      .strict(),
    companionRawOutput: CompanionRawOutputStatusSchema,
  })
  .strict();

const PublicSchemaVersionSchema = z
  .object({
    version: nonNegativeInteger,
    migrations: z.array(identifier).superRefine(uniqueStrings("迁移名不得重复")),
  })
  .strict();

const PublicStartupRecoverySchema = z
  .object({
    interruptedRuns: nonNegativeInteger,
    preservedPausedRuns: nonNegativeInteger,
    recoveredSubAgentScopes: nonNegativeInteger,
    preservedActiveSubAgentScopes: nonNegativeInteger,
    quarantinedSubAgentScopeEntries: nonNegativeInteger,
    pendingNotifications: nonNegativeInteger,
    recoveredAt: timestamp,
  })
  .strict();

const ToolPermissionSchema = z.enum(TOOL_PERMISSION_VALUES);
const PermissionScopeOrderSchema = z.tuple([
  z.literal(PERMISSION_SCOPE_ORDER[0]),
  z.literal(PERMISSION_SCOPE_ORDER[1]),
  z.literal(PERMISSION_SCOPE_ORDER[2]),
  z.literal(PERMISSION_SCOPE_ORDER[3]),
  z.literal(PERMISSION_SCOPE_ORDER[4]),
]);

export const PublicConfigResultSchema = z
  .object({
    profile: identifier,
    workspaceRoot: z.literal("[workspace]"),
    defaultWorkspaceKey: identifier,
    workspaces: z.array(
      z
        .object({
          id: identifier,
          label: displayText,
          root: z.string().regex(/^\[workspace(?::\d+)?\]$/u),
        })
        .strict(),
    ),
    routing: z
      .object({
        strategy: RoutingStrategySchema,
        fallback: z.boolean(),
      })
      .strict(),
    defaultModel: identifier,
    clients: z.array(PublicConfigClientSchema),
    capabilities: PublicConfigCapabilitiesSchema,
    security: z
      .object({
        permissions: z
          .object({
            allowed: z.array(ToolPermissionSchema).superRefine(uniqueStrings("权限不得重复")),
            scopeOrder: PermissionScopeOrderSchema,
          })
          .strict(),
        network: z
          .object({
            policyEnabled: z.literal(true),
            allowListConfigured: z.boolean(),
            denyListConfigured: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    schemaVersions: z
      .object({
        memory: PublicSchemaVersionSchema,
        tools: PublicSchemaVersionSchema.optional(),
      })
      .strict(),
    startupRecovery: PublicStartupRecoverySchema.optional(),
    generatedAt: timestamp,
  })
  .strict()
  .superRefine((result, context) => {
    const workspaceIds = result.workspaces.map((workspace) => workspace.id);
    if (new Set(workspaceIds).size !== workspaceIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaces"],
        message: "公开工作区 ID 不得重复",
      });
    }
    if (!workspaceIds.includes(result.defaultWorkspaceKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWorkspaceKey"],
        message: "默认工作区必须引用公开工作区",
      });
    }

    const clientNames = result.clients.map((client) => client.name);
    if (new Set(clientNames).size !== clientNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clients"],
        message: "公开模型客户端名称不得重复",
      });
    }
    if (result.defaultModel !== "auto" && !clientNames.includes(result.defaultModel)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultModel"],
        message: "默认模型必须是 auto 或引用公开客户端",
      });
    }

    const sandbox = result.capabilities.processSandbox;
    const hostMode = sandbox.mode === "danger-full-access";
    if (
      sandbox.backend !== (hostMode ? "host-process" : "windows-native") ||
      sandbox.osIsolation === hostMode
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "processSandbox"],
        message: "沙箱 backend、mode 与 osIsolation 必须一致",
      });
    }
  });

export const PublicConfigNoQuerySchema = z.object({}).strict();

export const PublicConfigQueryErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("CONFIG_QUERY_INVALID"),
  })
  .strict();

export const PublicConfigReadErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("CONFIG_READ_FAILED"),
  })
  .strict();

export function buildPublicConfigSnapshot(app: AppContext): PublicConfigResult {
  const clients = app.allModelConfigs()
    .map((config) => {
      const availability = app.modelAvailability.get(config.name);
      const publicAvailability = availability
        ? { available: availability.available, checkedAt: availability.checkedAt }
        : undefined;
      if (config.kind === "api") {
        return {
          kind: config.kind,
          name: config.name,
          provider: config.protocol,
          location: config.location,
          model: config.model,
          ...(publicAvailability ? { availability: publicAvailability } : {}),
        };
      }
      return {
        kind: config.kind,
        name: config.name,
        provider: config.runtime,
        location: config.location,
        model: config.model,
        ...(publicAvailability ? { availability: publicAvailability } : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const storage = app.registry.getStorage();
  const network = app.config.security?.network;
  const mode = app.processSandbox.mode;

  return PublicConfigResultSchema.parse({
    profile: app.profile,
    workspaceRoot: "[workspace]",
    defaultWorkspaceKey: app.defaultWorkspaceKey,
    workspaces: app.workspaceCatalog.entries.map((workspace, index) => ({
      id: workspace.id,
      label: workspace.label,
      root: index === 0 ? "[workspace]" : `[workspace:${index + 1}]`,
    })),
    routing: {
      strategy: app.config.routing.strategy,
      fallback: app.config.routing.fallback,
    },
    defaultModel: app.config.models.default,
    clients,
    capabilities: {
      ...trueCapabilities(),
      subAgentWorkspaceIsolation: {
        enabled: true,
        kind: "isolated_snapshot",
        broker: "session_write_scope",
        workspaceBinding: "parent_run_context",
        orphanRecovery: "lease_owner_verified",
        appliedToPrimary: false,
        primaryGitMetadataMutation: false,
      },
      processSandbox: {
        backend: mode === "danger-full-access" ? "host-process" : "windows-native",
        mode,
        environment: "allowlist",
        processTreeTermination: true,
        osIsolation: mode !== "danger-full-access",
        writeScopeProtocol: 3,
      },
      codeIntelligence: {
        typescriptAst: true,
        fallback: "text",
      },
      companionRawOutput: app.companionService.rawOutputStatus(),
    },
    security: {
      permissions: {
        allowed: app.projectAllowedPermissions,
        scopeOrder: [...PERMISSION_SCOPE_ORDER],
      },
      network: {
        policyEnabled: true,
        allowListConfigured: (network?.allowDomains.length ?? 0) > 0,
        denyListConfigured: (network?.denyDomains.length ?? 0) > 0,
      },
    },
    schemaVersions: {
      memory: {
        version: app.contextManager.db.schemaVersion,
        migrations: app.contextManager.db.schemaInfo.migrations.map((migration) => migration.name),
      },
      ...(storage
        ? {
            tools: {
              version: storage.schemaVersion,
              migrations: storage.schemaInfo.migrations.map((migration) => migration.name),
            },
          }
        : {}),
    },
    ...(app.startupRecovery ? { startupRecovery: app.startupRecovery } : {}),
    generatedAt: new Date().toISOString(),
  });
}

function trueCapabilities(): Record<PublicBooleanCapability, true> {
  return Object.fromEntries(
    PUBLIC_CONFIG_BOOLEAN_CAPABILITIES.map((key) => [key, true]),
  ) as Record<PublicBooleanCapability, true>;
}

function uniqueStrings(message: string) {
  return (values: readonly string[], context: z.RefinementCtx): void => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  };
}

export type PublicConfigResult = z.infer<typeof PublicConfigResultSchema>;
