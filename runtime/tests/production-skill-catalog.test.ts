import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it } from 'vitest';

import { createProductionSkillCatalog } from '../src/composition/runtime-capabilities/ProductionSkillCatalog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProductionSkillCatalog', () => {
  it('pins metadata at bootstrap and loads the exact body only through skill.load', async () => {
    const root = temporaryRoot();
    const skillFile = path.join(root, '.ariadne', 'skills', 'review', 'SKILL.md');
    mkdirSync(path.dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, [
      '---', 'name: review', 'description: Review changes for correctness.', '---',
      '', '# Review', '', 'PRIVATE SKILL BODY'
    ].join('\r\n'), 'utf8');
    const catalog = createProductionSkillCatalog(bootstrap(root, ['review']), new Map([
      ['workspace-skill', { rootPath: root, access: 'write' as const }]
    ]));

    expect(catalog.available).toBe(true);
    const admission = catalog.renderAdmissionCatalog('workspace-skill');
    expect(admission).toContain('review | sha256:');
    expect(admission).toContain('Review changes for correctness.');
    expect(admission).not.toContain('PRIVATE SKILL BODY');

    const descriptor = catalog.descriptors('workspace-skill')[0]!;
    const load = catalog.createToolRegistrations()[0]!;
    const context = {
      runId: 'run-skill', effectId: 'effect-skill', toolCallId: 'call-skill',
      idempotencyKey: 'idempotency-skill', capabilityIds: ['skills.read'],
      scope: ['workspace-skill'], signal: new AbortController().signal
    };
    await expect(load.executable.execute({
      name: 'review', revision: descriptor.revision
    }, context)).resolves.toMatchObject({
      status: 'succeeded', result: { body: expect.stringContaining('PRIVATE SKILL BODY') }
    });

    writeFileSync(skillFile, 'changed after admission', 'utf8');
    await expect(load.executable.execute({
      name: 'review', revision: descriptor.revision
    }, context)).resolves.toMatchObject({
      status: 'failed', errorCode: 'skill_load_failed', message: 'skill_source_drifted'
    });
  });

  it('does not advertise an incomplete configured catalog and fails admission closed', () => {
    const root = temporaryRoot();
    const catalog = createProductionSkillCatalog(bootstrap(root, ['missing']), new Map([
      ['workspace-skill', { rootPath: root, access: 'read' as const }]
    ]));
    expect(catalog.available).toBe(false);
    expect(() => catalog.renderAdmissionCatalog('workspace-skill'))
      .toThrow('skill_not_found:workspace-skill:missing');
  });
});

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
