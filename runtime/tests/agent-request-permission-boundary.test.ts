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
        create: () => ({ id: "run-1" }),
        update: () => undefined,
      },
      agentRunRegistry: {
        register: () => new AbortController(),
        unregister: () => undefined,
      },
      agentLoopFactory: {
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
        finalizeFailure: () => ({
          error: "failed",
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

      expect(result.status).toBe(200);
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
