import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('production packaging pipeline', () => {
  it('ships an isolated Runtime dependency tree and a verified standalone Node runner', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const rootPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      workspaces: string[];
    };
    const appPackage = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      build: { extraResources: Array<{ from: string; to: string }> };
    };
    const runtimeDistributionLock = JSON.parse(await readFile(
      path.join(projectRoot, 'packaging', 'runtime', 'package-lock.json'),
      'utf8'
    )) as { packages: Record<string, { resolved?: string }> };
    const prepareScript = await readFile(
      path.join(projectRoot, 'scripts', 'prepare-runtime-package.mjs'),
      'utf8'
    );

    expect(appPackage.scripts['package:win']).toContain('package:prepare');
    expect(appPackage.scripts['package:prepare']).toContain('build --workspace @ariadne/protocol');
    expect(appPackage.scripts['package:prepare']).toContain('build --workspace @ariadne/runtime');
    expect(appPackage.scripts['package:prepare']).toContain('--arch=x64');
    expect(appPackage.scripts['package:win']).toContain('--x64');
    expect(appPackage.scripts['package:win']).toContain('verify-windows-release-signing-environment.mjs');
    expect(appPackage.scripts['package:win']).toContain('--config.forceCodeSigning=true');
    expect(appPackage.scripts['package:win']).toContain('verify-windows-release-signatures.mjs');
    expect(rootPackage.scripts['verify:release']).toContain('audit:dependencies');
    expect(rootPackage.scripts['verify:release']).toContain('audit:runtime-independence');
    expect(rootPackage.workspaces).toEqual(['app', 'packages/protocol', 'runtime']);
    expect(rootPackage.scripts['audit:runtime-independence']).toBe(
      'node scripts/audit-runtime-independence.mjs'
    );
    expect(rootPackage.scripts['verify:release']).toContain('package:win');
    expect(appPackage.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'runtime-runner' }),
      expect.objectContaining({ to: 'runtime/node_modules' }),
      expect.objectContaining({ to: 'runtime/node_modules/@ariadne/runtime/.runtime/windows-sandbox' }),
      expect.objectContaining({ to: 'runtime/node_modules/@ariadne/runtime/.runtime/transformers' })
    ]));
    expect(runtimeDistributionLock.packages['node_modules/@ariadne/runtime']?.resolved).toBe('file:../../runtime');
    expect(prepareScript).toContain("const NODE_VERSION = '22.23.1'");
    expect(prepareScript).toContain('7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29');
    expect(prepareScript).toContain("return value?.trim() || 'x64'");
    expect(prepareScript).toContain("'--trusted', '--self-contained'");
    expect(prepareScript).toContain('verifyProductionAssets()');
  });

  it('keeps production dependencies inside the Ariadne workspace and rejects an inbound Runtime server', () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts', 'audit-runtime-independence.mjs')
    ], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      runtimeServerDirectoryAbsent: true,
      runtimePublicDirectoryAbsent: true,
      inboundHttpIndicators: [],
      externalFileDependencies: [],
      externalRootScriptPaths: []
    });
  });

  it('fails release signing closed without exposing or persisting certificate identifiers', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const preflight = await readFile(
      path.join(projectRoot, 'scripts', 'verify-windows-release-signing-environment.mjs'),
      'utf8'
    );
    const verification = await readFile(
      path.join(projectRoot, 'scripts', 'verify-windows-release-signatures.mjs'),
      'utf8'
    );

    expect(preflight).toContain('ARIADNE_APP_PUBLISHER_SHA256');
    expect(preflight).toContain('ARIADNE_SANDBOX_PUBLISHER_SHA256 must be 64 hex characters');
    expect(preflight).toContain('ARIADNE_SANDBOX_SIGN_CERT_SHA1 must be 40 hex characters');
    expect(preflight).toContain('ARIADNE_SANDBOX_TIMESTAMP_URL must be an HTTPS URL');
    expect(preflight).toContain('WIN_CSC_LINK or CSC_LINK');
    expect(verification).toContain("$signature.Status -ne 'Valid'");
    expect(verification).toContain('release_timestamp_missing');
    expect(verification).toContain('release_publisher_mismatch');
    expect(verification).toContain('Ariadne.WindowsSandbox.exe');
    expect(verification).toContain('verifySandboxManifest');
    expect(verification).not.toContain('writeFile');
  });

  it('rejects malformed helper signing configuration before packaging starts', () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts', 'verify-windows-release-signing-environment.mjs')
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        ARIADNE_APP_PUBLISHER_SHA256: 'a'.repeat(64),
        ARIADNE_SANDBOX_PUBLISHER_SHA256: 'invalid',
        ARIADNE_SANDBOX_SIGNTOOL_PATH: process.execPath,
        ARIADNE_SANDBOX_SIGN_CERT_SHA1: 'b'.repeat(40),
        ARIADNE_SANDBOX_TIMESTAMP_URL: 'https://timestamp.invalid',
        WIN_CSC_LINK: 'redacted-test-link',
        WIN_CSC_KEY_PASSWORD: 'redacted-test-password'
      }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ARIADNE_SANDBOX_PUBLISHER_SHA256 must be 64 hex characters');
    expect(result.stderr).not.toContain('redacted-test-link');
    expect(result.stderr).not.toContain('redacted-test-password');
  });
});
