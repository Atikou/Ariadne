import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("Agent permission resume integration", () => {
  it("continues the same provider tool call after approval across Windows path aliases", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-agent-resume-data-"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-agent-resume-workspace-"));
    roots.push(dataRoot, workspaceRoot);
    const proofPath = path.join(workspaceRoot, "proof.txt");
    const proofContent = "ARIADNE_PERMISSION_RESUME_OK";
    const proofInitialContent = "permission-resume fixture";
    const proofInitialHash = createHash("sha256").update(proofInitialContent).digest("hex");
    writeFileSync(proofPath, proofInitialContent, "utf8");
    let modelCalls = 0;

    process.env.OPENAI_API_KEY = "integration-test-key";
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.endsWith("/chat/completions")) {
        return Response.json({ error: { message: "unexpected request" } }, { status: 404 });
      }
      modelCalls += 1;
      if (modelCalls === 1) {
        return openAiJson({
          content: null,
          tool_calls: [{
            id: "provider-write-call",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: proofPath,
                content: proofContent,
                overwrite: true,
                createDirs: true,
                expectedSha256: proofInitialHash,
              }),
            },
          }],
        }, "tool_calls");
      }
      return openAiJson({
        content: JSON.stringify({
          action: "final",
          completionClaim: "completed",
          answer: "The proof file was created and verified.",
        }),
      }, "stop");
    };

    const app = createRuntimeContext(createBootstrap(dataRoot, workspaceRoot));
    const facade = new RuntimeFacade(app, () => {}, "0.1.0-test", {
      workspaces: [{ workspaceId: "primary", label: "Test workspace", access: "write" }],
      proposalApproval: "manual",
      allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
    });

    try {
      await app.start();
      await facade.start();
      const proposal = app.agentHandoffCoordinator.submitProposal({
        sourceTurnId: `turn-${randomUUID()}`,
        reason: "Exercise permission resume.",
        originalRequest: `Create ${proofPath} with exact content ${proofContent}.`,
        interpretedTask: "Create and verify the proof file.",
        requestedCapabilities: ["file-read", "file-write"],
        requestedScope: [workspaceRoot],
        risk: "write",
        workspaceKey: "primary",
        modelBinding: {
          selectionMode: "manual",
          clientName: "cloud-openai",
          modelName: "ariadne-test-model",
          protocolVersion: "ariadne.agent-proposal.v1",
        },
      });

      await facade.handle({
        kind: "agent.proposals.respond",
        proposalId: proposal.id,
        decision: "approve_once",
        allowedCapabilities: ["file-read", "file-write"],
        workspaceId: "primary",
      });

      const permission = await waitFor(async () => {
        const result = await facade.handle({ kind: "permissions.list" });
        const currentProposal = app.agentHandoffCoordinator.get(proposal.id);
        if (currentProposal?.status === "failed") {
          throw new Error(JSON.stringify(currentProposal));
        }
        return result.kind === "permissions" ? result.requests[0] : undefined;
      });
      expect(permission.permissionItems).toHaveLength(1);
      expect(permission.permissionItems[0]).toMatchObject({ capability: "write_file" });
      expect(app.runs.get(permission.runId)).toMatchObject({ status: "waiting_confirmation" });

      await facade.handle({
        kind: "permissions.respond",
        requestId: permission.requestId,
        approvalVersion: permission.approvalVersion,
        decision: "allow_once",
        approvedItemIds: permission.permissionItems.map((item) => item.itemId),
      });

      const completed = await waitFor(async () => {
        const current = app.runs.get(permission.runId);
        if (current?.status === "failed" || current?.status === "recovery_required") {
          throw new Error(JSON.stringify({
            status: current.status,
            error: current.error,
            waitingReason: current.waitingReason,
            recoveryStatus: current.recoveryStatus,
            ledger: app.runs.listToolLedger(permission.runId),
            proposal: app.agentHandoffCoordinator.getByRunId(permission.runId),
          }));
        }
        return current?.status === "completed" ? current : undefined;
      });
      expect(completed).toMatchObject({ status: "completed" });
      expect(readFileSync(proofPath, "utf8")).toBe(proofContent);
      expect(modelCalls).toBe(2);
      expect(app.permissionRequestStore.listPending()).toEqual([]);
      expect(app.runs.listToolLedger(permission.runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolName: "write_file",
          status: "succeeded",
        }),
      ]));
    } finally {
      await facade.stop();
      await app.shutdown();
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  }, 30_000);
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
      credentialEnvironmentVariable: "OPENAI_API_KEY",
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

function openAiJson(message: Record<string, unknown>, finishReason: string): Response {
  return Response.json({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: 0,
    model: "ariadne-test-model",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timeout");
}
