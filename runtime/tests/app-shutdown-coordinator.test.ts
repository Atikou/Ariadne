import { describe, expect, it, vi } from "vitest";

import { AppShutdownCoordinator } from "../src/app/AppShutdownCoordinator.js";
import { createShutdownContext } from "../src/ingress/ShutdownContext.js";

describe("AppShutdownCoordinator", () => {
  it("propagates one absolute deadline through preparation and final store closure", async () => {
    const order: string[] = [];
    const context = createShutdownContext(Date.now() + 5_000);
    const coordinator = new AppShutdownCoordinator(dependencies(order, context.deadlineAt));

    try {
      await coordinator.prepare(context);
      await coordinator.shutdown(context);
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      "hook",
      "runtime-producers-stopped",
      "agent-runs-cancelled",
      "background-stopped",
      "trace-closed",
      "trace-index-closed",
      "mcp-stopped",
      "registry-closed",
      "companion-closed",
      "project-index-closed",
      "telemetry-stopped",
      "context-db-closed",
    ]);
  });

  it("retains the primary database when the shutdown barrier is unproven", async () => {
    const contextDbClose = vi.fn();
    const coordinator = new AppShutdownCoordinator({
      ...dependencies([], Date.now() - 1),
      contextDb: { close: contextDbClose },
    });
    const context = createShutdownContext(Date.now() - 1);

    try {
      await expect(coordinator.shutdown(context)).rejects.toThrow("app_shutdown_barrier_failed");
    } finally {
      context.dispose();
    }

    expect(contextDbClose).not.toHaveBeenCalled();
  });

  it("does not close any store while an Agent run remains active", async () => {
    const order: string[] = [];
    const deadlineAt = Date.now() + 1_600;
    const base = dependencies(order, deadlineAt);
    const coordinator = new AppShutdownCoordinator({
      ...base,
      orchestrator: {
        listRunningAgentRuns: () => [{ runId: "held-run" }],
        cancelRun: () => { order.push("agent-runs-cancelled"); },
        waitUntilAgentRunIdle: () => new Promise<void>(() => undefined),
      },
    });
    const context = createShutdownContext(deadlineAt);

    try {
      await expect(coordinator.shutdown(context)).rejects.toThrow(
        "app_shutdown_barrier_failed"
      );
    } finally {
      context.dispose();
    }

    expect(order).toEqual([
      "hook",
      "runtime-producers-stopped",
      "agent-runs-cancelled",
      "background-stopped",
    ]);
  });
});

function dependencies(order: string[], expectedDeadlineAt: number) {
  return {
    runtime: {
      stop: async (context?: { deadlineAt: number }) => {
        expect(context?.deadlineAt).toBe(expectedDeadlineAt);
        order.push("runtime-producers-stopped");
      },
    },
    orchestrator: {
      listRunningAgentRuns: vi.fn()
        .mockReturnValueOnce([{ runId: "run-1" }])
        .mockReturnValue([]),
      cancelRun: () => { order.push("agent-runs-cancelled"); },
      waitUntilAgentRunIdle: async () => undefined,
    },
    backgroundTasks: {
      shutdown: async (timeoutMs?: number) => {
        expect(timeoutMs).toBeGreaterThan(0);
        order.push("background-stopped");
      },
    },
    trace: {
      close: async (context?: { deadlineAt: number }) => {
        expect(context?.deadlineAt).toBe(expectedDeadlineAt);
        order.push("trace-closed");
      },
      getIndexStore: () => ({ close: () => { order.push("trace-index-closed"); } }),
    },
    registry: { close: () => { order.push("registry-closed"); } },
    companionService: { close: () => { order.push("companion-closed"); } },
    mcp: { stop: async () => { order.push("mcp-stopped"); } },
    projectIndex: { dispose: async () => { order.push("project-index-closed"); } },
    contextDb: { close: () => { order.push("context-db-closed"); } },
    telemetry: { shutdown: async () => { order.push("telemetry-stopped"); } },
    hooks: {
      dispatch: async (input: { authority: { timeoutMs: number } }) => {
        expect(input.authority.timeoutMs).toBeGreaterThan(0);
        order.push("hook");
      },
    },
  };
}
