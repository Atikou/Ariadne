import type { ContextManager } from "../context/ContextManager.js";

export interface SessionWorkspaceResolverDeps {
  workspaceRoot: string;
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
    return this.deps.contextManager.createSession(title, projectId, workspaceKey).id;
  }

  workspaceForSession(sessionId?: string): string {
    return this.deps.resolveWorkspaceRoot?.(sessionId) ?? this.deps.workspaceRoot;
  }

  projectIdForSession(sessionId?: string, fallback?: string): string {
    const session = sessionId ? this.deps.contextManager.getSession(sessionId) : null;
    return session?.projectId ?? session?.workspaceKey ?? fallback ?? "default";
  }
}
