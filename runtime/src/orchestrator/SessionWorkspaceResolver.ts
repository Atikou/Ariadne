import type { ContextManager } from "../context/ContextManager.js";
import { sessionAgentStorageRoot } from "../agent/timeline/SessionAgentStorage.js";

export interface SessionWorkspaceResolverDeps {
  workspaceRoot: string;
  activityDataRoot: string;
  resolveWorkspaceRoot?: (sessionId?: string) => string;
  contextManager: Pick<ContextManager, "createSession" | "getSession">;
}

/** Resolves session identity and workspace/project ownership without executing workflows. */
export class SessionWorkspaceResolver {
  constructor(private readonly deps: SessionWorkspaceResolverDeps) {}

  ensureSession(
    sessionId: string | undefined,
    title: string,
    workspaceKey?: string,
    projectId?: string,
  ): string {
    if (sessionId && this.deps.contextManager.getSession(sessionId)) return sessionId;
    return this.deps.contextManager.createSession(
      title,
      projectId,
      workspaceKey,
      sessionId,
    ).id;
  }

  workspaceForSession(sessionId?: string): string {
    return this.deps.resolveWorkspaceRoot?.(sessionId) ?? this.deps.workspaceRoot;
  }

  activityRootForSession(sessionId: string): string {
    return sessionAgentStorageRoot(this.deps.activityDataRoot, sessionId);
  }

  projectIdForSession(sessionId?: string, fallback?: string): string {
    const session = sessionId ? this.deps.contextManager.getSession(sessionId) : null;
    return session?.projectId ?? session?.workspaceKey ?? fallback ?? "default";
  }
}
