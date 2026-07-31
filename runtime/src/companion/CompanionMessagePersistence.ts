import { CompanionMessageSchema } from "./CompanionSessionContracts.js";
import { createContentEnvelope } from "../context/messageEnvelope.js";
import type { ContentEnvelope } from "../core/ContentEnvelope.js";
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
  content_envelope_json: string;
  memory_eligible: number;
  model_name: string | null;
  client_name: string | null;
  storage_root: string;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
  reasoning_content: string | null;
  reasoning_status: "streaming" | "completed" | "interrupted" | null;
  reasoning_source: "provider" | "summary" | null;
  reasoning_started_at: string | null;
  reasoning_completed_at: string | null;
  reasoning_duration_ms: number | null;
}

export function mapCompanionMessageRow(row: CompanionMessageRow): CompanionMessage {
  return CompanionMessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    status: row.status,
    contentEnvelope: parseContentEnvelope(row.content_envelope_json),
    memoryEligible: row.memory_eligible === 1,
    modelName: row.model_name ?? undefined,
    clientName: row.client_name ?? undefined,
    storageRoot: row.storage_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reasoning_content !== null
      && row.reasoning_status
      && row.reasoning_source
      && row.reasoning_started_at
      ? {
          reasoning: {
            content: row.reasoning_content,
            status: row.reasoning_status,
            source: row.reasoning_source,
            startedAt: row.reasoning_started_at,
            ...(row.reasoning_completed_at
              ? { completedAt: row.reasoning_completed_at }
              : {}),
            ...(row.reasoning_duration_ms !== null
              ? { durationMs: row.reasoning_duration_ms }
              : {}),
          },
        }
      : {}),
    metadata: parseJsonObject(row.metadata_json),
  });
}

export function createCompanionMessageEnvelope(
  role: CompanionMessageRole,
  status: CompanionMessageStatus,
  sourceId: string,
): ContentEnvelope {
  if (role === "user") {
    return createContentEnvelope({
      origin: "user",
      evidence: "user_authored",
      verified: true,
      instructionAuthority: "user",
      externalContent: false,
      egressAllowed: ["model"],
      provenance: { sourceId },
    });
  }
  const completedAssistant = role === "assistant" && status === "completed";
  return createContentEnvelope({
    origin: role === "assistant" ? "model" : "workflow",
    evidence: completedAssistant ? "conversational_reply" : "unverified",
    verified: completedAssistant,
    instructionAuthority: "data",
    externalContent: true,
    egressAllowed: ["model"],
    provenance: { sourceId },
  });
}

export function serializeCompanionMessageEnvelope(
  role: CompanionMessageRole,
  status: CompanionMessageStatus,
  sourceId: string,
): string {
  return JSON.stringify(createCompanionMessageEnvelope(role, status, sourceId));
}

function parseContentEnvelope(value: string): ContentEnvelope {
  return CompanionMessageSchema.shape.contentEnvelope.parse(JSON.parse(value) as unknown);
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
