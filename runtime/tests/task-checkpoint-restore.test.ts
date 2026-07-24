import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskCheckpointService } from "../src/orchestrator/TaskCheckpointService.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const roots: string[] = [];
const registries: ReturnType<typeof createDefaultRegistry>[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task checkpoint restore", () => {
  it("blocks restore after a later user edit and makes a valid restore reversible", async () => {
    const { root, registry } = await fixture();
    const target = path.join(root, "file.txt");
    await writeFile(target, "before", "utf8");
    const changed = await registry.run("write_file", {
      path: "file.txt",
      content: "after",
    }, context(root));
    const sourceChangeId = (changed.output as { changeId: string }).changeId;

    await writeFile(target, "user-later", "utf8");
    const conflict = await registry.run(
      "rollback_change",
      { changeId: sourceChangeId },
      context(root),
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("restore_conflict_current_hash_mismatch");
    expect(await readFile(target, "utf8")).toBe("user-later");

    await writeFile(target, "after", "utf8");
    const restored = await registry.run(
      "rollback_change",
      { changeId: sourceChangeId },
      context(root),
    );
    expect(restored.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("before");

    const restoreChangeId = (restored.output as { changeId: string }).changeId;
    const undone = await registry.run(
      "rollback_change",
      { changeId: restoreChangeId },
      context(root),
    );
    expect(undone.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("after");
  });

  it("deletes a newly-created file and can undo that restore checkpoint", async () => {
    const { root, registry } = await fixture();
    const changed = await registry.run("write_file", {
      path: "new.txt",
      content: "created",
    }, context(root));
    const sourceChangeId = (changed.output as { changeId: string }).changeId;

    const restored = await registry.run(
      "rollback_change",
      { changeId: sourceChangeId },
      context(root),
    );
    expect(restored.ok).toBe(true);
    await expect(readFile(path.join(root, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restoreChangeId = (restored.output as { changeId: string }).changeId;
    expect((restored.output as { deletedFiles: string[] }).deletedFiles).toEqual(["new.txt"]);
    await expect(registry.run(
      "rollback_change",
      { changeId: restoreChangeId },
      context(root),
    )).resolves.toMatchObject({ ok: true });
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("created");
  });

  it("lists only the Run ledger changes and compares before restoring", async () => {
    const { root, registry } = await fixture();
    await writeFile(path.join(root, "tracked.txt"), "before", "utf8");
    const changed = await registry.run("write_file", {
      path: "tracked.txt",
      content: "after",
    }, context(root));
    await registry.run("write_file", {
      path: "other.txt",
      content: "unrelated",
    }, { ...context(root), requestId: "run-2" });
    const service = new TaskCheckpointService(registry, root);

    const checkpoints = await service.list("run-1");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      checkpointId: (changed.output as { changeId: string }).changeId,
      runId: "run-1",
      path: "tracked.txt",
      comparison: "matches",
      restorable: true,
    });

    await writeFile(path.join(root, "tracked.txt"), "later-user-edit", "utf8");
    await expect(service.restore({
      runId: "run-1",
      checkpointId: checkpoints[0]!.checkpointId,
    })).rejects.toThrow("task_checkpoint_restore_conflict:modified");
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("later-user-edit");
  });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-restore-"));
  roots.push(root);
  const registry = createDefaultRegistry({ dataDir: path.join(root, ".data") });
  registries.push(registry);
  return { root, registry };
}

function context(workspaceRoot: string) {
  return {
    workspaceRoot,
    requestId: "run-1",
    sessionId: "session-1",
    allowedPermissions: ["write" as const],
  };
}
