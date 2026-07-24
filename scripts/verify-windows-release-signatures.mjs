import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPackage = JSON.parse(readFileSync(path.join(projectRoot, 'app', 'package.json'), 'utf8'));
const outputRoot = path.join(projectRoot, 'dist', 'electron');
const expectedPublisher = process.env.ARIADNE_APP_PUBLISHER_SHA256?.trim().toLowerCase();
if (!expectedPublisher || !/^[0-9a-f]{64}$/u.test(expectedPublisher)) {
  throw new Error('ARIADNE_APP_PUBLISHER_SHA256 must be 64 hex characters.');
}
const expectedSandboxPublisher = process.env.ARIADNE_SANDBOX_PUBLISHER_SHA256?.trim().toLowerCase();
if (!expectedSandboxPublisher || !/^[0-9a-f]{64}$/u.test(expectedSandboxPublisher)) {
  throw new Error('ARIADNE_SANDBOX_PUBLISHER_SHA256 must be 64 hex characters.');
}
const installerName = String(appPackage.build?.artifactName ?? '')
  .replace('${version}', appPackage.version)
  .replace('${arch}', 'x64')
  .replace('${ext}', 'exe');
if (!installerName || installerName.includes('${')) {
  throw new Error('Windows release artifactName must resolve version, arch and ext placeholders.');
}

const sandboxRoot = path.join(
  outputRoot,
  'win-unpacked',
  'resources',
  'runtime',
  'node_modules',
  '@ariadne',
  'runtime',
  '.runtime',
  'windows-sandbox'

);
const sandboxHelper = path.join(sandboxRoot, 'Ariadne.WindowsSandbox.exe');
const targets = [
  { file: path.join(outputRoot, installerName), publisher: expectedPublisher },
  { file: path.join(outputRoot, 'win-unpacked', `${appPackage.productName}.exe`), publisher: expectedPublisher },
  { file: sandboxHelper, publisher: expectedSandboxPublisher }
];
for (const target of targets) {
  if (!existsSync(target.file)) {
    throw new Error(`Required signed release artifact is missing: ${path.relative(projectRoot, target.file)}`);
  }
  verifyAuthenticode(target.file, target.publisher);
}
verifySandboxManifest(path.join(sandboxRoot, 'Ariadne.WindowsSandbox.manifest.json'), sandboxHelper, expectedSandboxPublisher);
console.log(`windows-release: verified ${targets.length} signed artifacts`);

function verifyAuthenticode(file, publisherSha256) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:ARIADNE_VERIFY_RELEASE_FILE',
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'release_signature_invalid' }",
    "if ($null -eq $signature.TimeStamperCertificate) { throw 'release_timestamp_missing' }",
    '$sha = [Security.Cryptography.SHA256]::Create()',
    'try { $hash = $sha.ComputeHash($signature.SignerCertificate.RawData) } finally { $sha.Dispose() }',
    "$actual = ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()",
    "if ($actual -ne $env:ARIADNE_EXPECTED_RELEASE_PUBLISHER) { throw 'release_publisher_mismatch' }"
  ].join('; ');
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ARIADNE_VERIFY_RELEASE_FILE: file,
        ARIADNE_EXPECTED_RELEASE_PUBLISHER: publisherSha256
      },
      stdio: 'ignore',
      windowsHide: true
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Windows release signature verification failed: ${path.basename(file)}`);
  }
}

function verifySandboxManifest(manifestFile, helperFile, publisherSha256) {
  if (!existsSync(manifestFile)) {
    throw new Error(`Required sandbox manifest is missing: ${path.relative(projectRoot, manifestFile)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new Error('Packaged sandbox manifest is not valid JSON.');
  }
  const actualHelperSha256 = createHash('sha256').update(readFileSync(helperFile)).digest('hex');
  if (
    manifest?.schema !== 'ariadne_windows_sandbox_distribution'
    || manifest?.version !== 1
    || manifest?.helperFile !== path.basename(helperFile)
    || manifest?.sha256 !== actualHelperSha256
    || manifest?.trust?.kind !== 'authenticode_publisher'
    || manifest?.trust?.publisherCertificateSha256 !== publisherSha256
  ) {
    throw new Error('Packaged sandbox manifest does not match the signed helper.');
  }
}
