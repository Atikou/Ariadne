export type ContentOrigin =
  | "user"
  | "model"
  | "guard"
  | "system"
  | "workspace"
  | "tool"
  | "web"
  | "command"
  | "diff"
  | "mcp"
  | "subagent"
  | "workflow";

export type InstructionAuthority =
  | "system"
  | "user"
  | "workspace_root"
  | "target_directory"
  | "skill"
  | "data";
export type ContentDataSensitivity = "public" | "workspace" | "sensitive" | "secret";
export type ContentEgressTarget = "model" | "network" | "telemetry" | "log";
export type IntegrityEvidenceKind =
  | "unverified"
  | "user_authored"
  | "conversational_reply"
  | "completion_guard"
  | "tool_ledger"
  | "host_policy";

export interface ContentEnvelope {
  origin: ContentOrigin;
  provenance: {
    sourceId?: string;
    runId?: string;
    toolCallId?: string;
    providerId?: string;
  };
  integrityEvidence: {
    kind: IntegrityEvidenceKind;
    verified: boolean;
  };
  instructionAuthority: InstructionAuthority;
  dataSensitivity: ContentDataSensitivity;
  externalContent: boolean;
  egressAllowed: ContentEgressTarget[];
}
