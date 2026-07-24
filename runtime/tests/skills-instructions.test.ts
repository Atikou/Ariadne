import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentInstructionResolver,
  SkillRegistry,
  WorkspaceInstructionLoader,
  renderInstructionBlocks,
} from "../src/skills/SkillRegistry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Skills and layered workspace instructions", () => {
  it("resolves built-in, user, and workspace skills by explicit layer precedence", async () => {
    const root = await temporaryRoot();
    const builtIn = path.join(root, "built-in");
    const user = path.join(root, "user");
    const workspace = path.join(root, "workspace");
    for (const [directory, body] of [
      [builtIn, "built-in body"],
      [user, "user body"],
      [path.join(workspace, ".ariadne", "skills"), "workspace body"],
    ] as const) {
      await mkdir(path.join(directory, "review"), { recursive: true });
      await writeFile(path.join(directory, "review", "SKILL.md"), body, "utf8");
    }
    await writeFile(
      path.join(workspace, ".ariadne", "skills", "review", "script.ps1"),
      "throw 'must never run'",
      "utf8",
    );

    const registry = new SkillRegistry({ builtIn, user, workspace });
    expect(registry.resolve(["review"])[0]).toMatchObject({
      layer: "workspace",
      body: "workspace body",
    });
    expect(() => registry.resolve(["missing"])).toThrow("skill_not_found:missing");
  });

  it("orders root, target-directory, then skill instructions and blocks traversal", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const target = path.join(workspace, "src", "feature");
    await mkdir(path.join(workspace, ".ariadne", "skills", "review"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "root policy", "utf8");
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "source policy", "utf8");
    await writeFile(path.join(target, "AGENTS.md"), "feature policy", "utf8");
    await writeFile(
      path.join(workspace, ".ariadne", "skills", "review", "SKILL.md"),
      "review skill",
      "utf8",
    );

    const resolver = new AgentInstructionResolver(
      new SkillRegistry({ workspace }),
      new WorkspaceInstructionLoader(),
      ["review"],
    );
    const blocks = resolver.resolve(workspace, target);
    expect(blocks.map((block) => block.authority)).toEqual([
      "workspace_root",
      "target_directory",
      "target_directory",
      "skill",
    ]);
    const rendered = renderInstructionBlocks(blocks);
    expect(rendered.indexOf("root policy")).toBeLessThan(rendered.indexOf("source policy"));
    expect(rendered.indexOf("feature policy")).toBeLessThan(rendered.indexOf("review skill"));
    expect(() => resolver.resolve(workspace, path.join(root, "outside")))
      .toThrow("instruction_target_outside_workspace");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-skills-"));
  roots.push(root);
  return root;
}
