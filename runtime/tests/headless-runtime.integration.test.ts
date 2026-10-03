import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
} from "@ariadne/protocol/host";
import { parseHeadlessOutput, type HeadlessOutput } from "@ariadne/protocol/headless";
import { createDefaultRuntimePolicySnapshot } from "@ariadne/protocol/settings";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless NDJSON Runtime", () => {
  it("uses hello/command/shutdown with persistent event cursors and clean stdout", async () => {
    const fixture = await createFixture();
    const first = startHeadless();
    first.send(hello(fixture, 0));
    const ready = await first.waitFor("ready");
    expect(ready).toMatchObject({ protocolVersion: "3.0" });
    first.send({
      type: "command",
      requestId: "status-1",
      commandId: "headless-status-1",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    const response = await first.waitForResponse("status-1");
    expect(response).toMatchObject({
      requestId: "status-1",
      outcome: { ok: true, result: { kind: "runtime.status" } },
    });
    first.send({
      type: "command",
      requestId: "status-1-replay",
      commandId: "headless-status-1",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    const replay = await first.waitForResponse("status-1-replay");
    expect(replay.type === "response" && response.type === "response"
      ? replay.outcome
      : undefined).toEqual(response.type === "response" ? response.outcome : undefined);
    first.send({
      type: "command",
      requestId: "expired-1",
      commandId: "headless-expired-1",
      // Keep this independent from host clock adjustments between test and child process.
      deadlineAt: "2000-01-01T00:00:00.000Z",
      command: { kind: "projection.snapshot.get", contractVersion: "4.0" },
    });
    await expect(first.waitForResponse("expired-1")).resolves.toMatchObject({
      outcome: {
        ok: false,
        error: { code: "deadline_exceeded", retryable: false },
      },
    });
    first.send({ type: "shutdown", requestId: "shutdown-1" });
    await first.waitForResponse("shutdown-1");
    expect(await first.exit()).toBe(0);

    const second = startHeadless();
    second.send(hello(fixture, 0));
    await second.waitFor("ready");
    second.send({
      type: "command",
      requestId: "snapshot-2",
      commandId: "headless-snapshot-2",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "projection.snapshot.get", contractVersion: "4.0" },
    });
    await expect(second.waitForResponse("snapshot-2")).resolves.toMatchObject({
      outcome: { ok: true, result: { kind: "projection.snapshot" } },
    });
    second.send({ type: "shutdown", requestId: "shutdown-2" });
    await second.waitForResponse("shutdown-2");
    expect(await second.exit()).toBe(0);
  }, 30_000);

  it("--once exits successfully after exactly one command", async () => {
    const fixture = await createFixture();
    const process = startHeadless(["--once"]);
    process.send(hello(fixture, 0));
    await process.waitFor("ready");
    process.send({
      type: "command",
      requestId: "once-status",
      commandId: "headless-once-status",
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
      command: { kind: "runtime.status.get" },
    });
    await process.waitForResponse("once-status");
    expect(await process.exit()).toBe(0);
  }, 30_000);
});

async function createFixture(): Promise<{
  dataRoot: string;
  workspaceRoot: string;
  installRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-headless-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  return {
    dataRoot,
    workspaceRoot,
    installRoot: path.resolve(process.cwd()),
  };
}

function hello(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  resumeCursor: number,
) {
  return {
    type: "hello",
    protocolVersion: "3.0",
    resumeCursor,
    bootstrap: {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: randomUUID(),
      type: "bootstrap",
      appVersion: "test",
      runtimeVersion: "0.1.0",
      runtimeBuildFingerprint: "a".repeat(64),
      installRoot: fixture.installRoot,
      dataRoot: fixture.dataRoot,
      modelRoots: [path.join(fixture.dataRoot, "models")],
      modelProviders: [],
      routingStrategy: "privacy-first",
      agentPermissions: {
        approvalPolicy: "request",
        proposalApproval: "manual",
        permissionPolicy: "confirmBeforeRun",
        sandboxMode: "workspace-write",
        allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
      },
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: "disabled",
        reason: "not_configured",
      },
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: "local-only",
      workspaces: [{
        workspaceId: "test",
        label: "Test",
        rootPath: fixture.workspaceRoot,
        access: "write",
      }],
      production: false,
    },
  };
}

function startHeadless(args: string[] = []) {
  const child = spawn(
    process.execPath,
    [path.resolve(process.cwd(), "dist", "entry", "headless.js"), ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  const outputs: HeadlessOutput[] = [];
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    diagnostics += chunk.toString();
  });
  const waiters: Array<() => void> = [];
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    outputs.push(parseHeadlessOutput(JSON.parse(line)));
    for (const resolve of waiters.splice(0)) resolve();
  });
  const waitFor = async (type: HeadlessOutput["type"]): Promise<HeadlessOutput> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const index = outputs.findIndex((output) => output.type === type);
      if (index >= 0) return outputs.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(
      `headless output timeout:${type}:outputs=${JSON.stringify(outputs)}:stderr=${diagnostics.slice(-2_000)}`,
    );
  };
  return {
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    waitFor,
    async waitForResponse(requestId: string) {
      while (true) {
        const output = await waitFor("response");
        if (output.type === "response" && output.requestId === requestId) return output;
      }
    },
    async exit(): Promise<number | null> {
      if (child.exitCode === null) await once(child, "exit");
      return child.exitCode;
    },
  };
}
