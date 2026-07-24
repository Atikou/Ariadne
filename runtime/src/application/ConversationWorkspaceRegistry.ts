import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { atomicWriteFile } from '../lifecycle/fsUtils.js';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ASSIGNMENTS = 100_000;

const storedRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  assignments: z.record(
    z.string().min(1).max(512),
    z.string().min(1).max(512)
  ).refine((assignments) => Object.keys(assignments).length <= MAX_ASSIGNMENTS)
}).strict();

/**
 * Ariadne-owned sidecar metadata. Companion session storage stays host-agnostic
 * while the desktop host binds every public session to an authorized workspace.
 */
export class ConversationWorkspaceRegistry {
  private readonly assignments = new Map<string, string>();
  private readonly workspaceIds: ReadonlySet<string>;

  constructor(
    private readonly stateFile: string | undefined,
    workspaceIds: Iterable<string>,
    private readonly defaultWorkspaceId: string
  ) {
    this.workspaceIds = new Set(workspaceIds);
    if (!this.workspaceIds.has(defaultWorkspaceId)) {
      throw new Error('conversation_workspace_default_not_authorized');
    }
    this.load();
  }

  workspaceFor(sessionId: string): string {
    return this.assignments.get(sessionId) ?? this.defaultWorkspaceId;
  }

  assign(sessionId: string, workspaceId: string): void {
    if (!this.workspaceIds.has(workspaceId)) {
      throw new Error('conversation_workspace_not_authorized');
    }
    const previousWorkspaceId = this.assignments.get(sessionId);
    if (previousWorkspaceId === workspaceId) return;
    this.assignments.set(sessionId, workspaceId);
    try {
      this.persist();
    } catch (error) {
      if (previousWorkspaceId === undefined) this.assignments.delete(sessionId);
      else this.assignments.set(sessionId, previousWorkspaceId);
      throw error;
    }
  }

  remove(sessionId: string): void {
    const previousWorkspaceId = this.assignments.get(sessionId);
    if (previousWorkspaceId === undefined) return;
    this.assignments.delete(sessionId);
    try {
      this.persist();
    } catch (error) {
      this.assignments.set(sessionId, previousWorkspaceId);
      throw error;
    }
  }

  removeAfterAuthoritativeDelete(sessionId: string): void {
    if (!this.assignments.has(sessionId)) return;
    this.assignments.delete(sessionId);
    this.persist();
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    if (statSync(this.stateFile).size > MAX_STATE_BYTES) {
      throw new Error('conversation_workspace_state_too_large');
    }
    const stored = storedRegistrySchema.parse(JSON.parse(readFileSync(this.stateFile, 'utf8')));
    for (const [sessionId, workspaceId] of Object.entries(stored.assignments)) {
      if (!this.workspaceIds.has(workspaceId)) continue;
      this.assignments.set(sessionId, workspaceId);
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const assignments = Object.fromEntries(
      [...this.assignments.entries()].sort(([left], [right]) => left.localeCompare(right))
    );
    atomicWriteFile(this.stateFile, `${JSON.stringify({ schemaVersion: 1, assignments }, null, 2)}\n`);
  }
}
