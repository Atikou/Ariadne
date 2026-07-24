import { z } from "zod";

import { TOOL_PERMISSION_VALUES } from "../core/permissions.js";
import {
  TOOL_DATA_SENSITIVITY_VALUES,
  TOOL_EFFECT_VALUES,
  TOOL_EGRESS_VALUES,
  TOOL_IDEMPOTENCY_VALUES,
  TOOL_PARALLELISM_VALUES,
  TOOL_RESOURCE_SCOPE_VALUES,
  TOOL_RISK_VALUES,
  type ToolContractSpec,
} from "./types.js";

const toolName = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/);
const toolDescription = z.string().trim().min(1).max(4_096);
const jsonSchema = z.record(z.string(), z.unknown());

export const ToolCatalogPermissionSchema = z.enum(TOOL_PERMISSION_VALUES);

export const PublicToolCatalogEntrySchema = z.object({
  name: toolName,
  version: z.string().trim().min(1).max(64),
  description: toolDescription,
  permissions: z.array(ToolCatalogPermissionSchema).min(1).max(TOOL_PERMISSION_VALUES.length),
  resourceScopes: z.array(z.enum(TOOL_RESOURCE_SCOPE_VALUES)).min(1),
  effects: z.array(z.enum(TOOL_EFFECT_VALUES)).min(1),
  risk: z.enum(TOOL_RISK_VALUES),
  parallelism: z.enum(TOOL_PARALLELISM_VALUES),
  idempotency: z.enum(TOOL_IDEMPOTENCY_VALUES),
  dataSensitivity: z.enum(TOOL_DATA_SENSITIVITY_VALUES),
  egress: z.array(z.enum(TOOL_EGRESS_VALUES)).min(1),
  timeoutMs: z.number().int().positive(),
  supportsResume: z.boolean(),
  providerId: z.string().trim().min(1).max(128),
  inputJsonSchema: jsonSchema,
  outputJsonSchema: jsonSchema,
}).strict();

export const PublicToolCatalogResultSchema = z.object({
  tools: z.array(PublicToolCatalogEntrySchema).max(128),
  count: z.number().int().nonnegative().max(128),
}).strict().superRefine((catalog, ctx) => {
  if (catalog.count !== catalog.tools.length) {
    ctx.addIssue({ code: "custom", path: ["count"], message: "工具数量必须与目录一致" });
  }
  const names = catalog.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", path: ["tools"], message: "工具名称不得重复" });
  }
  if (names.some((name, index) => index > 0 && compareToolNames(name, names[index - 1]!) < 0)) {
    ctx.addIssue({ code: "custom", path: ["tools"], message: "工具目录必须按名称排序" });
  }
});

export const ToolCatalogQueryErrorResultSchema = z.object({
  error: z.literal("工具目录不接受查询参数"),
  code: z.literal("TOOL_CATALOG_QUERY_INVALID"),
}).strict();

export const ToolCatalogReadErrorResultSchema = z.object({
  error: z.literal("工具目录暂时不可用"),
  code: z.literal("TOOL_CATALOG_READ_FAILED"),
}).strict();

export function buildPublicToolCatalog(tools: readonly ToolContractSpec[]) {
  const entries = tools
    .map((tool) => ({
      ...tool,
      permissions: [...tool.permissions],
      resourceScopes: [...tool.resourceScopes],
      effects: [...tool.effects],
      egress: [...tool.egress],
      inputJsonSchema: { ...tool.inputJsonSchema },
      outputJsonSchema: { ...tool.outputJsonSchema },
    }))
    .sort((left, right) => compareToolNames(left.name, right.name));

  return PublicToolCatalogResultSchema.parse({ tools: entries, count: entries.length });
}

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
