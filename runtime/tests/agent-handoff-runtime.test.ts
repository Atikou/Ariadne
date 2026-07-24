import { describe, expect, it } from "vitest";

import {
  createAgentHandoffRuntime,
  preauthorizedHandoffPermissions,
} from "../src/app/createAgentHandoffRuntime.js";

describe("Agent handoff permission boundary", () => {
  it("keeps the AI capability ceiling separate from permissions already authorized", async () => {
    const calls: Array<{ body: Record<string, unknown>; execution: Record<string, unknown> }> = [];
    const db = { prepare: () => ({ all: () => [] }) };
    const root = "C:\\workspace";
    const coordinator = createAgentHandoffRuntime({
      contextManager: { db: { connection: db } } as never,
      workspaceCatalog: {
        defaultKey: "default",
        defaultRoot: root,
        entries: [{ id: "default", label: "Default", root, resolvedRoot: root }],
        byId: new Map([["default", {
          id: "default",
          label: "Default",
          root,
          resolvedRoot: root,
        }]]),
      },
      orchestrator: {
        runAgentFromHandoff: async (
          body: Record<string, unknown>,
          execution: Record<string, unknown>,
        ) => {
          calls.push({ body, execution });
          return {
            status: 200,
            body: { runId: "run-1", executionMeta: { stopReason: "completed" } },
          };
        },
      } as never,
      trace: { write: () => undefined } as never,
    });

    const deps = coordinator as unknown as {
      deps: { executeAgent(input: Record<string, unknown>): Promise<unknown> };
    };
    await deps.deps.executeAgent({
      proposalId: "proposal-1",
      grantId: "grant-1",
      originalRequest: "create the project",
      interpretedTask: "create the project",
      agentSessionId: "agent-session-1",
      workspaceKey: "default",
      grantedPermissions: ["read", "write", "shell"],
    });

    expect(calls[0]?.body).toMatchObject({
      message: "create the project",
      mode: "implement",
      permissionPolicy: "confirmBeforeRun",
      autoConfirm: false,
      skipPlanHandoff: true,
    });
    expect(calls[0]?.execution).toMatchObject({
      permissionCeiling: ["read", "write", "shell"],
      grantedPermissions: ["read"],
      pauseOnPermissionRequest: true,
    });
  });

  it("preauthorizes only the permissions selected by the user policy", () => {
    const ceiling = ["read", "write", "shell", "network"] as const;

    expect(preauthorizedHandoffPermissions(ceiling, "confirmBeforeRun"))
      .toEqual(["read"]);
    expect(preauthorizedHandoffPermissions(ceiling, "autoEdit"))
      .toEqual(["read", "write"]);
    expect(preauthorizedHandoffPermissions(ceiling, "autoRun"))
      .toEqual([...ceiling]);
  });
});
