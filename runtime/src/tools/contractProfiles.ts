import { z } from "zod";

import type { ToolContract } from "./types.js";

type ContractMetadata = Omit<
  ToolContract,
  "name" | "description" | "inputSchema" | "normalizeInput" | "resolvePermissions" | "execute"
>;

const structuredOutputSchema = z.record(z.string(), z.unknown());

export const WORKSPACE_READ_CONTRACT = {
  version: "1.0.0",
  outputSchema: structuredOutputSchema,
  permissions: ["read"],
  resourceScopes: ["workspace"],
  effects: ["workspace_read"],
  risk: "low",
  parallelism: "parallel_safe",
  idempotency: "idempotent",
  dataSensitivity: "workspace",
  egress: ["model"],
  timeoutMs: 30_000,
  supportsResume: true,
  providerId: "builtin",
} as const satisfies ContractMetadata;

export const WORKSPACE_WRITE_CONTRACT = {
  version: "1.0.0",
  outputSchema: structuredOutputSchema,
  permissions: ["write"],
  resourceScopes: ["workspace"],
  effects: ["workspace_write"],
  risk: "high",
  parallelism: "serial",
  idempotency: "keyed",
  dataSensitivity: "workspace",
  egress: ["model"],
  timeoutMs: 30_000,
  supportsResume: true,
  providerId: "builtin",
} as const satisfies ContractMetadata;

export const GIT_READ_CONTRACT = {
  ...WORKSPACE_READ_CONTRACT,
  resourceScopes: ["workspace", "git"],
} as const satisfies ContractMetadata;

export const PROCESS_CONTRACT = {
  version: "1.0.0",
  outputSchema: structuredOutputSchema,
  permissions: ["shell", "network"],
  resourceScopes: ["workspace", "process", "network"],
  effects: ["process", "unknown"],
  risk: "critical",
  parallelism: "serial",
  idempotency: "non_idempotent",
  dataSensitivity: "sensitive",
  egress: ["model", "network"],
  timeoutMs: 30_000,
  supportsResume: false,
  providerId: "builtin",
} as const satisfies ContractMetadata;

export const SUBAGENT_CONTRACT = {
  version: "1.0.0",
  outputSchema: structuredOutputSchema,
  permissions: ["read", "write", "shell"],
  resourceScopes: ["workspace", "process"],
  effects: ["unknown"],
  risk: "high",
  parallelism: "serial",
  idempotency: "non_idempotent",
  dataSensitivity: "workspace",
  egress: ["model"],
  timeoutMs: 120_000,
  supportsResume: false,
  providerId: "builtin",
} as const satisfies ContractMetadata;
