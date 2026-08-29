import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProductionSkillCatalog,
  type ProductionSkillCatalog,
  type ProductionSkillProvider
} from '../src/composition/runtime-capabilities/ProductionSkillCatalog.js';

const roots: string[] = [];
const catalogs: ProductionSkillCatalog[] = [];

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map(async (catalog) => catalog.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProductionSkillCatalog', () => {
  it('discovers per Workspace and loads only the exact revision pinned by admission', async () => {
    const root = temporaryRoot();
    const skillFile = writeSkill(root, '.ariadne/skills/review/SKILL.md', [
      '---', 'name: review', 'description: Review changes for correctness.', '---',
      '', '# Review', '', 'PRIVATE SKILL BODY'
    ].join('\r\n'));
    const catalog = createCatalog(root, ['review']);
    const signal = new AbortController().signal;

    const snapshot = await catalog.snapshot('workspace-skill', signal);
    expect(snapshot).toMatchObject({
      snapshotVersion: 2,
      complete: true,
      source: 'fresh',
      missing: [],
      skills: [{ name: 'review', layer: 'workspace' }]
    });
    const admission = await catalog.renderAdmissionCatalog('workspace-skill', signal);
    expect(admission).toContain('observation=complete');
    expect(admission).toContain('review | sha256:');
    expect(admission).toContain('Review changes for correctness.');
    expect(admission).not.toContain('PRIVATE SKILL BODY');

    const descriptor = snapshot.skills[0]!;
    const load = catalog.createToolRegistrations()[0]!;
    await expect(load.executable.execute({
      name: 'review', revision: descriptor.revision
    }, toolContext())).resolves.toMatchObject({
      status: 'succeeded', result: { body: expect.stringContaining('PRIVATE SKILL BODY') }
    });

    writeFileSync(skillFile, 'changed after admission', 'utf8');
    await expect(load.executable.execute({
      name: 'review', revision: descriptor.revision
    }, toolContext())).resolves.toMatchObject({
      status: 'failed', errorCode: 'skill_load_failed', message: 'skill_source_drifted'
    });
  });

  it('uses Workspace scope to override user and built-in candidates deterministically', async () => {
    const root = temporaryRoot();
    const userRoot = path.join(root, 'user-skills');
    writeSkill(root, 'skills/review/SKILL.md', skillBody('review', 'Built in.', 'BUILT IN'));
    writeSkill(userRoot, 'review/SKILL.md', skillBody('review', 'User.', 'USER'));
    writeSkill(root, '.ariadne/skills/review/SKILL.md', skillBody('review', 'Workspace.', 'WORKSPACE'));
    const runtime = bootstrap(root, ['review']);
    runtime.runtimePolicy.skills.userDirectory = userRoot;
    const catalog = track(createProductionSkillCatalog(runtime, workspaceBindings(root)));

    const snapshot = await catalog.snapshot('workspace-skill', new AbortController().signal);

    expect(snapshot.skills).toEqual([expect.objectContaining({
      name: 'review', description: 'Workspace.', layer: 'workspace'
    })]);
    const result = await catalog.createToolRegistrations()[0]!.executable.execute({
      name: 'review', revision: snapshot.skills[0]!.revision
    }, toolContext());
    expect(result).toMatchObject({ status: 'succeeded', result: { body: expect.stringContaining('WORKSPACE') } });
  });

  it('keeps model and user invocation policies independent and hides user-only Skills from the model', async () => {
    const root = temporaryRoot();
    writeSkill(root, '.ariadne/skills/model-only/SKILL.md', [
      '---', 'name: model-only', 'description: Model only.',
      'disable-model-invocation: false', 'user-invocable: false', '---', '', 'MODEL BODY'
    ].join('\n'));
    writeSkill(root, '.ariadne/skills/user-only/SKILL.md', [
      '---', 'name: user-only', 'description: User only.',
      'disable-model-invocation: true', 'user-invocable: true', '---', '', 'USER BODY'
    ].join('\n'));
    const catalog = createCatalog(root, ['model-only', 'user-only']);
    const signal = new AbortController().signal;

    const snapshot = await catalog.snapshot('workspace-skill', signal);
    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        name: 'model-only', invocation: { modelInvocable: true, userInvocable: false }
      }),
      expect.objectContaining({
        name: 'user-only', invocation: { modelInvocable: false, userInvocable: true }
      })
    ]);
    const admission = await catalog.renderAdmissionCatalog('workspace-skill', signal);
    expect(admission).toContain('model-only | sha256:');
    expect(admission).not.toContain('user-only | sha256:');

    const userOnly = snapshot.skills.find((skill) => skill.name === 'user-only')!;
    const load = catalog.createToolRegistrations().find(
      (registration) => registration.document.toolName === 'skill.load'
    )!;
    await expect(load.executable.execute({
      name: userOnly.name, revision: userOnly.revision
    }, toolContext())).resolves.toMatchObject({
      status: 'failed', errorCode: 'skill_load_failed', message: 'skill_model_invocation_disabled'
    });
  });

  it('pins package resources, reads only exact relative paths, and rejects resource drift', async () => {
    const root = temporaryRoot();
    const skillRoot = path.join(root, '.ariadne', 'skills', 'review');
    writeSkill(root, '.ariadne/skills/review/SKILL.md', skillBody(
      'review', 'Review with a checklist.', 'Read references/checklist.md only when needed.'
    ));
    const checklist = writeSkill(
      skillRoot,
      'references/checklist.md',
      '# Checklist\n\nCheck authority first.'
    );
    const assetPath = path.join(skillRoot, 'assets', 'sample.png');
    mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const catalog = createCatalog(root, ['review']);

    const snapshot = await catalog.snapshot('workspace-skill', new AbortController().signal);
    const descriptor = snapshot.skills[0]!;
    const registrations = catalog.createToolRegistrations();
    const load = registrations.find((entry) => entry.document.toolName === 'skill.load')!;
    const read = registrations.find((entry) => entry.document.toolName === 'skill.resource.read')!;
    expect(registrations.map((entry) => entry.document.toolName)).toEqual([
      'skill.load', 'skill.resource.read'
    ]);
    await expect(load.executable.execute({
      name: 'review', revision: descriptor.revision
    }, toolContext())).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        resources: [
          expect.objectContaining({ relativePath: 'assets/sample.png', mediaType: 'image/png' }),
          expect.objectContaining({ relativePath: 'references/checklist.md', mediaType: 'text/markdown' })
        ]
      }
    });
    await expect(read.executable.execute({
      name: 'review', revision: descriptor.revision, relativePath: 'references/checklist.md'
    }, toolContext())).resolves.toMatchObject({
      status: 'succeeded',
      result: { encoding: 'utf8', content: expect.stringContaining('Check authority first.') }
    });
    expect(read.executable.normalizeAndValidate({
      name: 'review', revision: descriptor.revision, relativePath: '../outside.txt'
    })).toEqual({ status: 'rejected' });

    writeFileSync(checklist, '# Changed after admission', 'utf8');
    await expect(read.executable.execute({
      name: 'review', revision: descriptor.revision, relativePath: 'references/checklist.md'
    }, toolContext())).resolves.toMatchObject({
      status: 'failed', errorCode: 'skill_resource_read_failed', message: 'skill_source_drifted'
    });
  });

  it('retains last-good only for a transiently incomplete provider observation', async () => {
    const root = temporaryRoot();
    let attempt = 0;
    const body = skillBody('review', 'Review safely.', 'LAST GOOD BODY');
    const revision = digest(body);
    const provider: ProductionSkillProvider = {
      providerId: 'skills.test-transient',
      precedence: 100,
      list: async () => {
        attempt += 1;
        if (attempt > 1) throw new Error('temporary_provider_failure');
        return [{
          name: 'review', description: 'Review safely.', revision,
          layer: 'workspace', invocation: { modelInvocable: true, userInvocable: true },
          locator: 'review'
        }];
      },
      get: async () => ({
        name: 'review', description: 'Review safely.', revision,
        layer: 'workspace', invocation: { modelInvocable: true, userInvocable: true },
        body, resources: []
      })
    };
    const catalog = createCatalog(root, ['review'], [provider]);

    const fresh = await catalog.snapshot('workspace-skill', new AbortController().signal);
    const fallback = await catalog.snapshot('workspace-skill', new AbortController().signal);

    expect(fresh).toMatchObject({ complete: true, source: 'fresh' });
    expect(fallback).toMatchObject({
      complete: false,
      source: 'last_good',
      catalogDigest: fresh.catalogDigest,
      missing: []
    });
    await expect(catalog.renderAdmissionCatalog(
      'workspace-skill',
      new AbortController().signal
    )).resolves.toContain('observation=last-good');
  });

  it('clears last-good and fails admission after authoritative removal', async () => {
    const root = temporaryRoot();
    const skillFile = writeSkill(
      root,
      '.ariadne/skills/review/SKILL.md',
      skillBody('review', 'Review safely.', 'BODY')
    );
    const catalog = createCatalog(root, ['review']);
    await catalog.snapshot('workspace-skill', new AbortController().signal);
    rmSync(skillFile);

    const removed = await catalog.snapshot('workspace-skill', new AbortController().signal);

    expect(removed).toMatchObject({ complete: true, source: 'fresh', missing: ['review'] });
    await expect(catalog.renderAdmissionCatalog(
      'workspace-skill',
      new AbortController().signal
    )).rejects.toThrow('skill_not_found:workspace-skill:review');
  });

  it('does not publish an incomplete first observation as an admission catalog', async () => {
    const root = temporaryRoot();
    const provider: ProductionSkillProvider = {
      providerId: 'skills.test-incomplete',
      precedence: 100,
      list: async () => ({ candidates: [], complete: false }),
      get: async () => undefined
    };
    const catalog = createCatalog(root, ['review'], [provider]);

    await expect(catalog.renderAdmissionCatalog(
      'workspace-skill',
      new AbortController().signal
    )).rejects.toThrow('skill_catalog_incomplete:workspace-skill');
  });

  it('cancels uncooperative discovery and aborts it again when the Provider closes', async () => {
    const root = temporaryRoot();
    const close = vi.fn();
    const provider: ProductionSkillProvider = {
      providerId: 'skills.test-stalled',
      precedence: 100,
      list: async () => new Promise<never>(() => undefined),
      get: async () => undefined,
      close
    };
    const catalog = createCatalog(root, ['review'], [provider]);
    const controller = new AbortController();
    const cancelled = catalog.snapshot('workspace-skill', controller.signal);
    controller.abort(new Error('caller_cancelled'));
    await expect(cancelled).rejects.toThrow('caller_cancelled');

    const closing = catalog.snapshot('workspace-skill', new AbortController().signal);
    await catalog.close();
    catalogs.splice(catalogs.indexOf(catalog), 1);
    await expect(closing).rejects.toThrow('skill_catalog_closed');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function createCatalog(
  root: string,
  enabled: string[],
  providers?: readonly ProductionSkillProvider[]
): ProductionSkillCatalog {
  return track(createProductionSkillCatalog(
    bootstrap(root, enabled),
    workspaceBindings(root),
    providers === undefined ? {} : { providers }
  ));
}

function track(catalog: ProductionSkillCatalog): ProductionSkillCatalog {
  catalogs.push(catalog);
  return catalog;
}

function workspaceBindings(root: string) {
  return new Map([['workspace-skill', { rootPath: root, access: 'write' as const }]]);
}

function toolContext() {
  return {
    runId: 'run-skill', effectId: 'effect-skill', toolCallId: 'call-skill',
    idempotencyKey: 'idempotency-skill', capabilityIds: ['skills.read'],
    scope: ['workspace-skill'], signal: new AbortController().signal
  };
}

function writeSkill(root: string, relativePath: string, body: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function skillBody(name: string, description: string, body: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n');
}

function digest(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-production-skill-'));
  roots.push(root);
  return root;
}

function bootstrap(root: string, enabled: string[]): RuntimeBootstrap {
  const runtimePolicy = createDefaultRuntimePolicySnapshot();
  runtimePolicy.skills.enabled = enabled;
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: '00000000-0000-4000-8000-000000000099',
    type: 'bootstrap', appVersion: '0.1.0', runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: 'a'.repeat(64), installRoot: root, dataRoot: root,
    modelRoots: [], agentAdmissionAuthoritySource: {
      sourceVersion: 1, status: 'disabled', reason: 'not_configured'
    },
    runtimePolicy, profile: 'test', workspaces: [{
      workspaceId: 'workspace-skill', label: 'Skill Workspace', rootPath: root, access: 'write'
    }], production: false
  };
}
