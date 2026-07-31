import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy } from "../src/policy/PathPolicy.js";
import { evaluatePermissionGuard } from "../src/policy/PermissionGuard.js";
import { permissionItemsFromConfirmation } from "../src/policy/PermissionRequestStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("path and permission normalization", () => {
  it("prepares a canonical workspace-relative path when Windows aliases differ", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-path-alias-"));
    roots.push(workspaceRoot);
    const absoluteTarget = path.join(workspaceRoot, "proof.txt");

    const prepared = new PathPolicy({ primaryRoot: workspaceRoot }).prepareTool(
      "write_file",
      { path: absoluteTarget, content: "proof" },
    );

    expect(prepared).toBeDefined();
    expect(prepared?.decision).toMatchObject({
      allowed: true,
      reason: "inside_primary_workspace",
    });
    expect(prepared?.input.path).toBe("proof.txt");
    expect(String(prepared?.input.path)).not.toContain("..");
  });

  it("does not turn a file-write risk target into an unrelated network permission", () => {
    const decision = evaluatePermissionGuard({
      intent: "edit",
      permissionPolicy: "confirmBeforeRun",
      toolName: "write_file",
      permission: "write",
      input: { path: "proof.txt", content: "proof" },
      allowedPermissions: ["read", "write"],
    });

    expect(decision.decision).toBe("needsConfirmation");
    expect(decision.confirmationRequest?.affects).toMatchObject({
      files: ["proof.txt"],
      networkTargets: [],
    });
    expect(permissionItemsFromConfirmation(decision.confirmationRequest!)).toEqual([
      expect.objectContaining({
        type: "write_file",
        target: "proof.txt",
      }),
    ]);
  });

  it("keeps the workspace as execution root when an exact one-time grant is more specific", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-scoped-path-"));
    roots.push(workspaceRoot);
    const absoluteTarget = path.join(workspaceRoot, "proof.txt");

    const prepared = new PathPolicy({ primaryRoot: workspaceRoot }).prepareTool(
      "write_file",
      { path: absoluteTarget, content: "proof" },
      { scopedGrants: { write_file: [absoluteTarget] } },
    );

    expect(prepared).toBeDefined();
    expect(prepared?.decision.matchedScope).toMatchObject({
      kind: "temporary",
      source: "user_confirmed",
    });
    expect(prepared?.workspaceRoot).toBe(realpathSync.native(workspaceRoot));
    expect(prepared?.input.path).toBe("proof.txt");
  });

  it("uses an external file parent as execution root without widening the approved target", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-primary-path-"));
    const externalRoot = mkdtempSync(path.join(process.cwd(), ".ariadne-external-path-"));
    roots.push(workspaceRoot, externalRoot);
    const absoluteTarget = path.join(externalRoot, "proof.txt");

    const prepared = new PathPolicy({ primaryRoot: workspaceRoot }).prepareTool(
      "write_file",
      { path: absoluteTarget, content: "proof" },
      { scopedGrants: { write_file: [absoluteTarget] } },
    );

    expect(prepared?.decision).toMatchObject({
      allowed: true,
      crossWorkspace: true,
      matchedScope: {
        rootPath: absoluteTarget,
        kind: "temporary",
      },
    });
    expect(prepared?.workspaceRoot).toBe(realpathSync.native(externalRoot));
    expect(prepared?.input.path).toBe("proof.txt");
  });
});
