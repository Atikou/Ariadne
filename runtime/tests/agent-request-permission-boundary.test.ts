import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import {
  AgentRequestService,
  type AgentRequestServiceDeps,
} from "../src/orchestrator/AgentRequestService.js";

describe("AgentRequestService permission boundary", () => {
  it("passes the AI capability ceiling to tool visibility without preauthorizing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-agent-permission-"));
    const loopRequests: Array<Record<string, unknown>> = [];
    const service = new AgentRequestService({
      agentRuntime: {
        runPolicyManager: {
          parseMode: (value?: string) => value === "implement" ? "implement" : undefined,
          parsePermissionPolicy: (value?: string) => value === "autoRun" ? "autoRun" : undefined,
          resolveAsync: async (input: unknown) =>
            resolveRunPolicy(input as Parameters<typeof resolveRunPolicy>[0]),
        },
      },
      sessionWorkspace: {
        ensureSession: () => "session-1",
        workspaceForSession: () => root,
        activityRootForSession: () => path.join(root, "session-owner"),
        projectIdForSession: () => "project-1",
      },
      taskService: {
        resolveOrCreateTask: () => ({
          id: "task-1",
          goal: "update the project",
          status: "in_progress",
        }),
        createDetachedTask: () => ({
          id: "task-1",
          goal: "update the project",
          status: "in_progress",
        }),
      },
      runs: {
        execute: (command: { type: string }) =>
          command.type === "run.create"
            ? { id: "run-1", aggregateVersion: 1 }
            : { id: "run-1", aggregateVersion: 2 },
        get: () => ({
          id: "run-1",
          kind: "agent",
          status: "completed",
          aggregateVersion: 3,
        }),
      },
      agentRunRegistry: {
        register: () => new AbortController(),
        unregister: () => undefined,
      },
      executionEngines: {
        create: (request: Record<string, unknown>) => {
          loopRequests.push(request);
          return { run: async () => ({ answer: "ok" }) };
        },
      },
      agentRunLifecycle: {
        traceStart: () => undefined,
        finalizeSuccess: () => ({
          answer: "ok",
          runId: "run-1",
          taskId: "task-1",
        }),
        finalizeFailure: (_context: unknown, error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          code: "INTERNAL_ERROR",
          runId: "run-1",
          taskId: "task-1",
        }),
      },
      makeChatFn: () => async () => ({ content: "unused" }),
    } as unknown as AgentRequestServiceDeps);

    try {
      const result = await service.run(
        {
          message: "update the project",
          mode: "implement",
          permissionPolicy: "autoRun",
        },
        undefined,
        undefined,
        {
          permissionCeiling: ["read", "write", "dangerous"],
          grantedPermissions: ["read"],
          authorization: { proposalId: "proposal-1", grantId: "grant-1" },
          pauseOnPermissionRequest: true,
        },
      );

      expect(result).toMatchObject({ status: 200 });
      expect(loopRequests[0]).toMatchObject({
        allowedPermissions: ["read", "write", "dangerous"],
        runGrantedPermissions: ["read"],
        handoffAuthorization: {
          proposalId: "proposal-1",
          grantId: "grant-1",
        },
        pauseOnPermissionRequest: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
