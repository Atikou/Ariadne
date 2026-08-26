import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { AgentToolJsonValue } from '@ariadne/agent-core';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';

import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredStringProperty,
  succeeded,
  type WorkspaceBinding
} from '../first-party-tools/FirstPartyAgentToolSupport.js';

const MAX_SKILL_BYTES = 128 * 1024;

export type ProductionSkillLayer = 'built_in' | 'user' | 'workspace';

export interface ProductionSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly revision: string;
  readonly layer: ProductionSkillLayer;
}

interface PinnedSkill extends ProductionSkillDescriptor {
  readonly filePath: string;
}

/** Bootstrap-frozen Skill metadata. Bodies are read only by the skill.load Tool. */
export interface ProductionSkillCatalog {
  readonly available: boolean;
  renderAdmissionCatalog(workspaceId: string): string;
  createToolRegistrations(): readonly TrustedAgentToolRegistrationV1[];
  descriptors(workspaceId: string): readonly ProductionSkillDescriptor[];
}

export function createProductionSkillCatalog(
  bootstrap: RuntimeBootstrap,
  workspaces: ReadonlyMap<string, WorkspaceBinding>
): ProductionSkillCatalog {
  const enabled = new Set(bootstrap.runtimePolicy.skills.enabled);
  const catalogs = new Map<string, ReadonlyMap<string, PinnedSkill>>();
  const missing = new Map<string, readonly string[]>();
  for (const [workspaceId, workspace] of workspaces) {
    const discovered = discoverSkills({
      builtIn: path.join(bootstrap.installRoot, 'skills'),
      user: bootstrap.runtimePolicy.skills.userDirectory,
      workspace: workspace.rootPath
    });
    const selected = new Map<string, PinnedSkill>();
    for (const name of [...enabled].sort(compareCodeUnits)) {
      const skill = discovered.get(name);
      if (skill === undefined) continue;
      selected.set(name, skill);
    }
    const missingNames = [...enabled].filter((name) => !selected.has(name));
    if (missingNames.length > 0) missing.set(workspaceId, Object.freeze(missingNames));
    catalogs.set(workspaceId, selected);
  }

  const catalog: ProductionSkillCatalog = Object.freeze({
    available: missing.size === 0,
    descriptors: (workspaceId: string) => Object.freeze(
      [...requireCompleteWorkspaceCatalog(catalogs, missing, workspaceId).values()].map(publicDescriptor)
    ),
    renderAdmissionCatalog: (workspaceId: string) => renderCatalog(
      [...requireCompleteWorkspaceCatalog(catalogs, missing, workspaceId).values()]
    ),
    createToolRegistrations: () => Object.freeze([
      skillLoadRegistration(catalogs, workspaces)
    ])
  });
  return catalog;
}

function requireCompleteWorkspaceCatalog(
  catalogs: ReadonlyMap<string, ReadonlyMap<string, PinnedSkill>>,
  missing: ReadonlyMap<string, readonly string[]>,
  workspaceId: string
): ReadonlyMap<string, PinnedSkill> {
  const unavailable = missing.get(workspaceId);
  if (unavailable !== undefined) {
    throw new Error(`skill_not_found:${workspaceId}:${unavailable.join(',')}`);
  }
  return requireWorkspaceCatalog(catalogs, workspaceId);
}

function discoverSkills(roots: {
  readonly builtIn?: string;
  readonly user?: string;
  readonly workspace: string;
}): ReadonlyMap<string, PinnedSkill> {
  const byName = new Map<string, PinnedSkill>();
  for (const [layer, root] of [
    ['built_in', roots.builtIn],
    ['user', roots.user],
    ['workspace', path.join(roots.workspace, '.ariadne', 'skills')]
  ] as const) {
    if (root === undefined || !existsSync(root)) continue;
    const canonicalRoot = realpathSync(root);
    for (const name of readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9_-]*$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodeUnits)) {
      const candidate = path.join(root, name, 'SKILL.md');
      if (!existsSync(candidate)) continue;
      const filePath = realpathSync(candidate);
      if (!isWithin(canonicalRoot, filePath)) throw new Error(`skill_path_outside_root:${name}`);
      const body = readBoundedSkill(filePath);
      const metadata = parseMetadata(body, name);
      if (metadata.name !== name) throw new Error(`skill_name_mismatch:${name}`);
      byName.set(name, Object.freeze({
        name,
        description: metadata.description,
        revision: digest(body),
        layer,
        filePath
      }));
    }
  }
  return byName;
}

function skillLoadRegistration(
  catalogs: ReadonlyMap<string, ReadonlyMap<string, PinnedSkill>>,
  workspaces: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'skill.load',
    capabilityIds: ['skills.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'workspace_resource_id',
    inputSchema: objectSchema({
      name: { type: 'string', description: 'Exact Skill name from the admission catalog.' },
      revision: { type: 'string', description: 'Exact sha256 revision from the admission catalog.' }
    }, ['name', 'revision']),
    outputSchema: { type: 'object' },
    validate: validateLoadInput,
    execute: async (input, context) => {
      try {
        if (context.scope.length !== 1 || !workspaces.has(context.scope[0]!)) {
          throw new Error('skill_workspace_scope_invalid');
        }
        const workspaceId = context.scope[0]!;
        const skill = requireWorkspaceCatalog(catalogs, workspaceId).get(
          requiredStringProperty(input, 'name')
        );
        if (skill === undefined) throw new Error('skill_not_pinned');
        const revision = requiredStringProperty(input, 'revision');
        if (revision !== skill.revision) throw new Error('skill_revision_not_pinned');
        if (!existsSync(skill.filePath) || realpathSync(skill.filePath) !== skill.filePath) {
          throw new Error('skill_source_unavailable');
        }
        const body = readBoundedSkill(skill.filePath);
        if (digest(body) !== revision) throw new Error('skill_source_drifted');
        return succeeded({
          ...publicDescriptor(skill),
          body
        });
      } catch (error) {
        return failed('skill_load_failed', error);
      }
    }
  });
}

function validateLoadInput(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['name', 'revision'])) {
    return { status: 'rejected' as const };
  }
  const { name, revision } = input;
  return typeof name === 'string'
    && /^[a-z][a-z0-9_-]*$/u.test(name)
    && typeof revision === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(revision)
    ? { status: 'accepted' as const, input: { name, revision } }
    : { status: 'rejected' as const };
}

function renderCatalog(skills: readonly PinnedSkill[]): string {
  if (skills.length === 0) return '';
  const entries = skills.map((skill) => (
    `- ${skill.name} | ${skill.revision} | ${skill.description}`
  )).join('\n');
  return [
    '[SKILL_CATALOG authority=runtime-pinned]',
    'Skill bodies are not instructions until loaded. When one is relevant, call skill.load with the exact name and revision below; treat the protected Tool result as the Skill instructions for this Run.',
    entries,
    '[/SKILL_CATALOG]'
  ].join('\n');
}

function parseMetadata(body: string, fallbackName: string): {
  readonly name: string;
  readonly description: string;
} {
  const normalized = body.replaceAll('\r\n', '\n');
  let frontmatter = '';
  let content = normalized;
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4);
    if (end < 0) throw new Error(`skill_frontmatter_invalid:${fallbackName}`);
    frontmatter = normalized.slice(4, end);
    content = normalized.slice(end + 5);
  }
  const fields = new Map<string, string>();
  for (const line of frontmatter.split('\n')) {
    const match = /^([a-z][a-z0-9_-]*):\s*(.+)$/u.exec(line.trim());
    if (match !== null) fields.set(match[1]!, stripQuotes(match[2]!.trim()));
  }
  const name = fields.get('name') ?? fallbackName;
  const description = fields.get('description') ?? firstDescription(content) ?? `Instructions for ${name}.`;
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error(`skill_metadata_invalid:${fallbackName}`);
  if (description.length === 0 || description.length > 512 || /[\r\n]/u.test(description)) {
    throw new Error(`skill_description_invalid:${fallbackName}`);
  }
  return { name, description };
}

function firstDescription(body: string): string | undefined {
  return body.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '---' && !line.startsWith('#'))
    ?.slice(0, 512);
}

function stripQuotes(value: string): string {
  return value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function readBoundedSkill(filePath: string): string {
  const content = readFileSync(filePath);
  if (content.byteLength > MAX_SKILL_BYTES) throw new Error(`skill_file_too_large:${filePath}`);
  if (content.includes(0)) throw new Error(`skill_file_binary:${filePath}`);
  return content.toString('utf8');
}

function requireWorkspaceCatalog(
  catalogs: ReadonlyMap<string, ReadonlyMap<string, PinnedSkill>>,
  workspaceId: string
): ReadonlyMap<string, PinnedSkill> {
  const catalog = catalogs.get(workspaceId);
  if (catalog === undefined) throw new Error('skill_workspace_unknown');
  return catalog;
}

function publicDescriptor(skill: PinnedSkill): ProductionSkillDescriptor {
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    revision: skill.revision,
    layer: skill.layer
  });
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
