import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FirstPartyToolArtifactAuthority,
  verifyFirstPartyToolArtifactManifest
} from '../src/composition/first-party-tools/FirstPartyToolArtifactAuthority.js';

const projectRuntimeRoot = path.resolve(import.meta.dirname, '..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('FirstPartyToolArtifactAuthority', () => {
  it('verifies every build-generated first-party implementation module', () => {
    expect(verifyFirstPartyToolArtifactManifest()).toEqual([
      'dist/composition/first-party-tools/BrowserAgentTools.js',
      'dist/composition/first-party-tools/ComputerReadAgentTools.js',
      'dist/composition/first-party-tools/LiveWorkControlAgentTools.js',
      'dist/composition/first-party-tools/LiveWorkStartAgentTools.js',
      'dist/composition/first-party-tools/McpAgentTools.js',
      'dist/composition/first-party-tools/ProtectedResultAgentTools.js',
      'dist/composition/first-party-tools/WorkspaceAgentTools.js',
      'dist/composition/first-party-tools/WorkspaceFileAgentTools.js',
      'dist/composition/first-party-tools/WorkspaceSearchAgentTools.js',
      'dist/composition/runtime-capabilities/ProductionSkillLoadTool.js'
    ]);
  });

  it('returns the exact verified closure for a source or built module URL', () => {
    const root = copyArtifactFixture();
    const authority = new FirstPartyToolArtifactAuthority(root);
    const sourceModule = pathToFileURL(path.join(
      root,
      'src',
      'composition',
      'first-party-tools',
      'WorkspaceFileAgentTools.ts'
    )).href;
    const builtModule = pathToFileURL(path.join(
      root,
      'dist',
      'composition',
      'first-party-tools',
      'WorkspaceFileAgentTools.js'
    )).href;

    const source = authority.implementationFor(sourceModule);
    const built = authority.implementationFor(builtModule);
    expect(source.execute.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(source.execute)).toEqual(Buffer.from(built.execute));
    expect(source.provider).toBe(source.execute);
  });

  it('rejects a packaged JavaScript byte changed after manifest generation', () => {
    const root = copyArtifactFixture();
    const target = path.join(
      root,
      'dist',
      'composition',
      'first-party-tools',
      'FirstPartyAgentToolSupport.js'
    );
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// drift\n`, 'utf8');

    expect(() => new FirstPartyToolArtifactAuthority(root)).toThrow(
      'first_party_tool_artifact_file_drift:'
      + 'dist/composition/first-party-tools/FirstPartyAgentToolSupport.js'
    );
  });
});

function copyArtifactFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-tool-artifacts-'));
  temporaryRoots.push(root);
  const manifestRelative = path.join('config', 'first-party-tool-artifacts.json');
  const manifest = JSON.parse(readFileSync(
    path.join(projectRuntimeRoot, manifestRelative),
    'utf8'
  )) as {
    readonly modules: readonly {
      readonly files: readonly { readonly path: string }[];
    }[];
  };
  copyFile(manifestRelative, root);
  for (const file of new Set(
    manifest.modules.flatMap((module) => module.files.map((entry) => entry.path))
  )) copyFile(file, root);
  return root;
}

function copyFile(relativePath: string, targetRoot: string): void {
  const target = path.join(targetRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(path.join(projectRuntimeRoot, relativePath)));
}
