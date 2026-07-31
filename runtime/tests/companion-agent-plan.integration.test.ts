import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap,
} from "@ariadne/protocol/host";
import { createDefaultRuntimePolicySnapshot } from "@ariadne/protocol/settings";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeContext } from "../src/application/createRuntimeContext.js";
import { RuntimeFacade } from "../src/application/RuntimeFacade.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Companion Agent Plan integration", () => {
  it("keeps planning and approved execution on the same Chat message and Agent Run", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ARIADNE_PLAN_TEST_API_KEY;
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-plan-data-"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-plan-workspace-"));
    roots.push(dataRoot, workspaceRoot);
    let modelCalls = 0;
    process.env.ARIADNE_PLAN_TEST_API_KEY = "integration-test-key";
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.endsWith("/chat/completions")) {
        return Response.json({ error: { message: "unexpected request" } }, { status: 404 });
      }
      modelCalls += 1;
      const requestBody = await request.clone().json() as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const approvedPlan = requestBody.messages
        ?.map((message) => message.content ?? "")
        .join("\n")
        .match(/必须执行已批准的\s+(\S+)\s+v(\d+)/);
      return openAiJson({
        action: "final",
        completionClaim: modelCalls === 1 ? "completed" : "partial",
        answer: modelCalls === 1
          ? "## Implementation plan\n\n1. Inspect the target.\n2. Apply the change.\n3. Verify it."
          : "Approved plan execution finished without changing the fixture.",
        ...(modelCalls === 1
          ? {
              plan: {
                title: "Implementation plan",
                goal: "Implement the requested small feature and verify the observable result.",
                facts: [{
                  id: "fact-1",
                  statement: "The fixture workspace is available for an approved implementation run.",
                  evidence: "The integration test created and selected the temporary workspace.",
                }],
                constraints: [{
                  id: "constraint-1",
                  kind: "constraint",
                  statement: "Do not mutate the fixture before the user approves the plan.",
                }],
                clarifications: [],
                steps: [
                  {
                    id: "step-1",
                    title: "Inspect the target module",
                    dependsOn: [],
                    action: "Read the relevant project files and identify the implementation boundary.",
                    scope: ["target module"],
                    expectedOutcome: "The affected implementation surface is identified.",
                    verification: "Record the inspected paths and the behavior that must change.",
                  },
                  {
                    id: "step-2",
                    title: "Implement the requested feature",
                    dependsOn: ["step-1"],
                    action: "Apply the scoped code changes described by the approved request.",
                    scope: ["target module"],
                    expectedOutcome: "The requested behavior is present in the implementation.",
                    verification: "Review the resulting diff against the approved scope.",
                  },
                  {
                    id: "step-3",
                    title: "Verify the implemented behavior",
                    dependsOn: ["step-2"],
                    action: "Run the relevant deterministic verification and inspect its result.",
                    scope: ["target verification"],
                    expectedOutcome: "The implementation is supported by reproducible evidence.",
                    verification: "Confirm the verification command exits successfully.",
                  },
                ],
                completionCriteria: [{
                  id: "done-1",
                  behavior: "The requested feature is observable in the target module after approval.",
                  verification: "Repeat the deterministic integration verification and compare the result.",
                }],
              },
            }
          : {
              planExecution: {
                planId: approvedPlan?.[1] ?? "missing-plan-id",
                version: Number(approvedPlan?.[2] ?? 1),
                steps: ["step-1", "step-2", "step-3"].map((stepId) => ({
                  stepId,
                  status: "pending",
                  actualScope: [],
                  evidence: [],
                  deviations: [],
                })),
              },
            }),
      });
    };

    const app = createRuntimeContext(createBootstrap(dataRoot, workspaceRoot));
    const facade = new RuntimeFacade(app, () => {}, "0.1.0-test", {
      activityDataRoot: dataRoot,
      workspaces: [{ workspaceId: "primary", label: "Test workspace", access: "write" }],
      agentPermissionPolicy: "confirmBeforeRun",
    });

    try {
      await app.start();
      await facade.start();
      const accepted = await facade.handle({
        kind: "companion.chat.start",
        clientMessageId: "plan-user-message",
        message: "Plan and then implement a small feature after I approve it",
        modelId: "cloud-openai",
        workspaceId: "primary",
        agentMode: "plan",
        resources: [],
      });
      expect(accepted.kind).toBe("companion.chat.accepted");
      if (accepted.kind !== "companion.chat.accepted") throw new Error("unexpected result");
      expect(accepted.executionMode).toBe("agent-plan");

      const handoff = await waitFor(async () => {
        const result = await facade.handle({ kind: "planHandoffs.list" });
        return result.kind === "planHandoffs"
          ? result.handoffs.find((candidate) => candidate.runId === accepted.runId)
          : undefined;
      });
      const beforeApproval = await facade.handle({
        kind: "companion.messages.list",
        sessionId: accepted.sessionId,
        limit: 20,
      });
      expect(beforeApproval).toMatchObject({
        kind: "companion.messages",
        messages: [
          {
            messageId: "plan-user-message",
            role: "user",
            status: "completed",
          },
          {
            runId: accepted.runId,
            role: "assistant",
            content: "",
            status: "streaming",
            reasoning: {
              status: "streaming",
              segments: [
                expect.objectContaining({
                  kind: "intermediate_response",
                  content: expect.stringContaining("# Implementation plan"),
                }),
              ],
            },
          },
        ],
      });
      const waitingRun = await facade.handle({ kind: "runs.get", runId: accepted.runId });
      expect(waitingRun).toMatchObject({
        kind: "run",
        run: {
          runId: accepted.runId,
          sessionId: accepted.sessionId,
          sourceMessageId: "plan-user-message",
          origin: "agent",
          status: "waiting_plan_handoff",
        },
      });

      await facade.handle({
        kind: "planHandoffs.respond",
        handoffId: handoff.handoffId,
        decision: "approve",
      });
      const completedMessages = await waitFor(async () => {
        const result = await facade.handle({
          kind: "companion.messages.list",
          sessionId: accepted.sessionId,
          limit: 20,
        });
        if (
          result.kind === "companion.messages"
          && result.messages[1]?.status === "interrupted"
          && result.messages[1].content.includes("尚未真实完成")
        ) {
          return result.messages;
        }
        return undefined;
      }).catch(async (error) => {
        const run = await facade.handle({ kind: "runs.get", runId: accepted.runId });
        const handoffs = await facade.handle({ kind: "planHandoffs.list" });
        const messages = await facade.handle({
          kind: "companion.messages.list",
          sessionId: accepted.sessionId,
          limit: 20,
        });
        throw new Error(JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          modelCalls,
          run,
          handoffs,
          messages,
        }));
      });
      expect(completedMessages).toHaveLength(2);
      expect(completedMessages[1]).toMatchObject({
        runId: accepted.runId,
        status: "interrupted",
        content: expect.stringContaining("尚未真实完成"),
        reasoning: {
          status: "interrupted",
        },
      });
      expect(completedMessages[1]?.content).toContain("Tool Ledger");
      expect(completedMessages[1]?.content).not.toContain("# Implementation plan");
      expect(modelCalls).toBe(2);
      const settledPlan = app.agentPlanStore.getLatestForSession(accepted.sessionId);
      expect(settledPlan).toMatchObject({
        planState: "approved",
        executionState: "blocked",
      });
    } finally {
      await facade.stop();
      await app.shutdown();
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.ARIADNE_PLAN_TEST_API_KEY;
      else process.env.ARIADNE_PLAN_TEST_API_KEY = originalKey;
    }
  }, 45_000);
});

function createBootstrap(dataRoot: string, workspaceRoot: string): RuntimeBootstrap {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: "bootstrap",
    appVersion: "0.1.0",
    runtimeVersion: "0.1.0",
    runtimeBuildFingerprint: "a".repeat(64),
    installRoot: packageRoot,
    dataRoot,
    modelRoots: [],
    modelProviders: [{
      providerId: "openai",
      name: "cloud-openai",
      protocol: "openai-compatible",
      credentialEnvironmentVariable: "ARIADNE_PLAN_TEST_API_KEY",
      enabled: true,
      baseUrl: "https://api.example.test/v1",
      model: "ariadne-test-model",
      inference: {},
    }],
    routingStrategy: "cloud-first",
    agentPermissions: {
      approvalPolicy: "request",
      proposalApproval: "manual",
      permissionPolicy: "confirmBeforeRun",
      sandboxMode: "workspace-write",
      allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: "default",
    workspaces: [{
      workspaceId: "primary",
      label: "Temporary workspace",
      rootPath: workspaceRoot,
      access: "write",
    }],
    production: false,
  };
}

function openAiJson(action: Record<string, unknown>): Response {
  return Response.json({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: 0,
    model: "ariadne-test-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(action) },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timeout");
}
