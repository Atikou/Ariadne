import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { ProjectIndex } from "../src/context/ProjectIndex.js";
import type { ProjectFileRecord } from "../src/context/projectIndexTypes.js";

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent repo map", () => {
  it("persists symbols, references, diagnostics, and returns a task-ranked minimal subgraph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-repo-map-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "billing.ts"),
      "export class BillingService { charge(): string { return 'ok'; } }\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "src", "controller.ts"),
      "import { BillingService } from './billing';\nexport const controller = new BillingService();\n",
      "utf8",
    );
    await writeFile(path.join(workspaceRoot, "src", "broken.py"), "def broken(:\n  pass\n", "utf8");
    await writeFile(path.join(workspaceRoot, "README.md"), "# Unrelated Notes\n", "utf8");

    const database = new DatabaseManager(path.join(root, "data"));
    databases.push(database);
    const index = new ProjectIndex(database);
    const result = await index.syncFiles({
      projectId: "project-1",
      workspaceRoot,
      files: [
        record("src/billing.ts", ".ts", "hash-billing"),
        record("src/controller.ts", ".ts", "hash-controller"),
        record("src/broken.py", ".py", "hash-broken"),
        record("README.md", ".md", "hash-readme"),
      ],
      pruneMissing: true,
    });

    expect(result.symbolsUpdated).toBeGreaterThan(0);
    expect(result.referencesUpdated).toBeGreaterThan(0);
    expect(result.diagnosticsUpdated).toBeGreaterThan(0);

    const references = database.connection.prepare(
      `SELECT symbol FROM project_references
       WHERE project_id='project-1' AND file_path='src/controller.ts'`,
    ).all() as Array<{ symbol: string }>;
    expect(references.some((row) => row.symbol === "BillingService")).toBe(true);

    const diagnostics = database.connection.prepare(
      `SELECT message FROM project_diagnostics
       WHERE project_id='project-1' AND file_path='src/broken.py'`,
    ).all() as Array<{ message: string }>;
    expect(diagnostics.length).toBeGreaterThan(0);

    const map = index.getRelevantRepoMap(
      "project-1",
      workspaceRoot,
      "fix BillingService controller",
      { limit: 3 },
    );
    expect(map.map((node) => node.path)).toContain("src/billing.ts");
    expect(map.map((node) => node.path)).toContain("src/controller.ts");
    expect(map.map((node) => node.path)).not.toContain("README.md");
    expect(map.find((node) => node.path === "src/controller.ts")?.imports)
      .toContain("src/billing.ts");
  });

  it("removes every derived repo-map record during a full-scan prune", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-repo-prune-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "removed.ts"), "export const removed = 1;\n", "utf8");

    const database = new DatabaseManager(path.join(root, "data"));
    databases.push(database);
    const index = new ProjectIndex(database);
    await index.syncFiles({
      projectId: "project-1",
      workspaceRoot,
      files: [record("removed.ts", ".ts", "hash-removed")],
      pruneMissing: true,
    });
    await index.syncFiles({
      projectId: "project-1",
      workspaceRoot,
      files: [],
      pruneMissing: true,
    });

    for (const table of [
      "project_files",
      "project_symbols",
      "project_imports",
      "project_exports",
      "project_references",
      "project_diagnostics",
    ]) {
      const row = database.connection.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE project_id='project-1'`,
      ).get() as { count: number };
      expect(row.count).toBe(0);
    }
  });
});

function record(filePath: string, extension: string, contentHash: string): ProjectFileRecord {
  return {
    path: filePath,
    fileName: path.posix.basename(filePath),
    extension,
    sizeBytes: 1,
    modifiedAt: "2026-07-24T00:00:00.000Z",
    mtimeMs: 1,
    contentHash,
    language: extension.slice(1),
    tags: [],
  };
}
