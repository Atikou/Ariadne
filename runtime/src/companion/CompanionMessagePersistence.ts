import { CompanionMessageSchema } from "./CompanionSessionContracts.js";
import type {
  CompanionMessage,
  CompanionMessageRole,
  CompanionMessageStatus,
} from "./types.js";

export interface CompanionMessageRow {
  id: string;
  session_id: string;
  role: CompanionMessageRole;
  content: string;
  status: CompanionMessageStatus;
  trusted: number;
  memory_eligible: number;
  model_name: string | null;
  client_name: string | null;
  storage_root: string;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
}

export function mapCompanionMessageRow(row: CompanionMessageRow): CompanionMessage {
  return CompanionMessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    status: row.status,
    trusted: row.trusted === 1,
    memoryEligible: row.memory_eligible === 1,
    modelName: row.model_name ?? undefined,
    clientName: row.client_name ?? undefined,
    storageRoot: row.storage_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJsonObject(row.metadata_json),
  });
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
