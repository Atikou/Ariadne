import { z } from "zod";

import { TOOL_PERMISSION_VALUES, type ToolPermission } from "../core/permissions.js";
import type { ToolSpec } from "./types.js";

const toolName = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/);
const toolDescription = z.string().trim().min(1).max(4_096);
const inputField = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const ToolCatalogPermissionSchema = z.enum(TOOL_PERMISSION_VALUES);

export const PublicToolCatalogEntrySchema = z.object({
  name: toolName,
  description: toolDescription,
  permission: ToolCatalogPermissionSchema,
  possiblePermissions: z.array(ToolCatalogPermissionSchema).min(1).max(TOOL_PERMISSION_VALUES.length),
  hasSideEffect: z.boolean(),
  inputFields: z.array(inputField).max(64),
}).strict().superRefine((entry, ctx) => {
  if (new Set(entry.possiblePermissions).size !== entry.possiblePermissions.length) {
    ctx.addIssue({ code: "custom", path: ["possiblePermissions"], message: "工具权限不得重复" });
  }
  if (!entry.possiblePermissions.includes(entry.permission)) {
    ctx.addIssue({ code: "custom", path: ["possiblePermissions"], message: "工具权限范围必须包含主权限" });
  }
  if (new Set(entry.inputFields).size !== entry.inputFields.length) {
    ctx.addIssue({ code: "custom", path: ["inputFields"], message: "工具输入字段不得重复" });
  }
  if (
    !entry.hasSideEffect &&
    entry.possiblePermissions.some((permission) =>
      permission === "write" || permission === "shell" || permission === "dangerous")
  ) {
    ctx.addIssue({ code: "custom", path: ["hasSideEffect"], message: "高副作用权限必须显式标记副作用" });
  }
});

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

const permissionOrder = new Map<ToolPermission, number>(
  TOOL_PERMISSION_VALUES.map((permission, index) => [permission, index]),
);

export function buildPublicToolCatalog(tools: readonly ToolSpec[]) {
  const entries = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    permission: tool.permission,
    possiblePermissions: [...new Set([tool.permission, ...(tool.possiblePermissions ?? [])])]
      .sort((left, right) => permissionOrder.get(left)! - permissionOrder.get(right)!),
    hasSideEffect: tool.hasSideEffect,
    inputFields: [...(tool.inputFields ?? [])],
  })).sort((left, right) => compareToolNames(left.name, right.name));

  return PublicToolCatalogResultSchema.parse({ tools: entries, count: entries.length });
}

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
