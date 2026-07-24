import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export type SkillLayer = "built_in" | "user" | "workspace";

export interface LoadedSkill {
  name: string;
  layer: SkillLayer;
  filePath: string;
  body: string;
}

export interface InstructionBlock {
  authority: "workspace_root" | "target_directory" | "skill";
  source: string;
  text: string;
}

/**
 * Loads declarative SKILL.md files from three layers. A higher layer replaces
 * the same skill name; no script is executed and no permission is granted.
 */
export class SkillRegistry {
  constructor(private readonly roots: {
    builtIn?: string;
    user?: string;
    workspace: string;
  }) {}

  discover(): LoadedSkill[] {
    const byName = new Map<string, LoadedSkill>();
    for (const layer of ["built_in", "user", "workspace"] as const) {
      const root = this.layerRoot(layer);
      if (!root || !existsSync(root)) continue;
      for (const name of readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9_-]*$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort()) {
        const filePath = path.join(root, name, "SKILL.md");
        if (!existsSync(filePath)) continue;
        byName.set(name, {
          name,
          layer,
          filePath: realpathSync(filePath),
          body: readBoundedText(filePath, 128 * 1024),
        });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(names: readonly string[]): LoadedSkill[] {
    const available = new Map(this.discover().map((skill) => [skill.name, skill]));
    return names.map((name) => {
      const skill = available.get(name);
      if (!skill) throw new Error(`skill_not_found:${name}`);
      return skill;
    });
  }

  private layerRoot(layer: SkillLayer): string | undefined {
    if (layer === "built_in") return this.roots.builtIn;
    if (layer === "user") return this.roots.user;
    return path.join(this.roots.workspace, ".ariadne", "skills");
  }
}

export class WorkspaceInstructionLoader {
  resolve(workspaceRoot: string, targetDirectory?: string): InstructionBlock[] {
    const root = canonical(workspaceRoot);
    const target = canonical(targetDirectory ?? root);
    if (!isWithin(root, target)) throw new Error("instruction_target_outside_workspace");

    const directories: string[] = [];
    let cursor = target;
    while (true) {
      directories.push(cursor);
      if (samePath(cursor, root)) break;
      cursor = path.dirname(cursor);
    }
    directories.reverse();

    const blocks: InstructionBlock[] = [];
    for (const [index, directory] of directories.entries()) {
      for (const fileName of [".ariadne/INSTRUCTIONS.md", "AGENTS.md"]) {
        const filePath = path.join(directory, fileName);
        if (!existsSync(filePath)) continue;
        blocks.push({
          authority: index === 0 ? "workspace_root" : "target_directory",
          source: path.relative(root, filePath).replace(/\\/gu, "/") || fileName,
          text: readBoundedText(filePath, 128 * 1024),
        });
      }
    }
    return blocks;
  }
}

export class AgentInstructionResolver {
  constructor(
    private readonly skills: SkillRegistry,
    private readonly workspaceInstructions: WorkspaceInstructionLoader,
    private readonly enabledSkills: readonly string[],
  ) {}

  resolve(workspaceRoot: string, targetDirectory?: string): InstructionBlock[] {
    return [
      ...this.workspaceInstructions.resolve(workspaceRoot, targetDirectory),
      ...this.skills.resolve(this.enabledSkills).map((skill): InstructionBlock => ({
        authority: "skill",
        source: `${skill.layer}:${skill.name}`,
        text: skill.body,
      })),
    ];
  }
}

export function renderInstructionBlocks(blocks: readonly InstructionBlock[]): string {
  return blocks.map((block) => [
    `[INSTRUCTION authority=${block.authority} source=${block.source}]`,
    block.text,
    "[/INSTRUCTION]",
  ].join("\n")).join("\n\n");
}

function readBoundedText(filePath: string, maxBytes: number): string {
  const content = readFileSync(filePath);
  if (content.byteLength > maxBytes) throw new Error(`instruction_file_too_large:${filePath}`);
  if (content.includes(0)) throw new Error(`instruction_file_binary:${filePath}`);
  return content.toString("utf8");
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
