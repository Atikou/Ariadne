import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(packageRoot, ".runtime", "windows-sandbox");
const helperFile = "Ariadne.WindowsSandbox.exe";
const helperPath = path.join(outputDirectory, helperFile);
const manifestPath = path.join(outputDirectory, "Ariadne.WindowsSandbox.manifest.json");
const trusted = process.argv.slice(2).includes("--trusted");
const selfContained = process.argv.slice(2).includes("--self-contained");
const publisherCertificateSha256 = normalizePublisher(
  process.env.ARIADNE_SANDBOX_PUBLISHER_SHA256,
  trusted,
);
const signing = trusted ? resolveSigningOptions() : undefined;

const publishArgs = [
  "publish",
  "native/Ariadne.WindowsSandbox/Ariadne.WindowsSandbox.csproj",
  "-c", "Release",
  "-r", "win-x64",
  "--self-contained", String(selfContained),
  "-o", outputDirectory,
  `-p:AriadneTrustedPublisherSha256=${publisherCertificateSha256 ?? ""}`,
];
run("dotnet", publishArgs);

if (signing) {
  run(signing.signToolPath, [
    "sign",
    "/fd", "SHA256",
    "/sha1", signing.certificateSha1,
    "/tr", signing.timestampUrl,
    "/td", "SHA256",
    helperPath,
  ]);
  verifyAuthenticode(helperPath, publisherCertificateSha256);
}

const sha256 = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
const manifest = {
  schema: "ariadne_windows_sandbox_distribution",
  version: 1,
  helperFile,
  sha256,
  trust: trusted
    ? {
        kind: "authenticode_publisher",
        publisherCertificateSha256,
      }
    : { kind: "development_unsigned" },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `windows-sandbox: published ${trusted ? "trusted" : "development"} helper and manifest`,
);

function normalizePublisher(value, required) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    if (required) {
      throw new Error(
        "ARIADNE_SANDBOX_PUBLISHER_SHA256 is required for a trusted publish",
      );
    }
    return undefined;
  }
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error("ARIADNE_SANDBOX_PUBLISHER_SHA256 must be 64 hex characters");
  }
  return normalized;
}

function resolveSigningOptions() {
  if (process.platform !== "win32") {
    throw new Error("trusted Windows sandbox publishing requires Windows");
  }
  const signToolPath = process.env.ARIADNE_SANDBOX_SIGNTOOL_PATH?.trim();
  if (!signToolPath || !path.isAbsolute(signToolPath) || !existsSync(signToolPath)) {
    throw new Error(
      "ARIADNE_SANDBOX_SIGNTOOL_PATH must name an existing absolute SignTool path",
    );
  }
  const certificateSha1 = process.env.ARIADNE_SANDBOX_SIGN_CERT_SHA1
    ?.trim()
    .toLowerCase();
  if (!certificateSha1 || !/^[0-9a-f]{40}$/u.test(certificateSha1)) {
    throw new Error("ARIADNE_SANDBOX_SIGN_CERT_SHA1 must be 40 hex characters");
  }
  const timestampUrl = process.env.ARIADNE_SANDBOX_TIMESTAMP_URL?.trim();
  let parsedTimestamp;
  try {
    parsedTimestamp = timestampUrl ? new URL(timestampUrl) : undefined;
  } catch {
    parsedTimestamp = undefined;
  }
  if (!parsedTimestamp || parsedTimestamp.protocol !== "https:") {
    throw new Error("ARIADNE_SANDBOX_TIMESTAMP_URL must be an HTTPS URL");
  }
  return { signToolPath, certificateSha1, timestampUrl: parsedTimestamp.href };
}

function verifyAuthenticode(file, expectedPublisher) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:ARIADNE_VERIFY_HELPER",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'authenticode_signature_invalid' }",
    "if ($null -eq $signature.TimeStamperCertificate) { throw 'authenticode_timestamp_missing' }",
    "$sha = [Security.Cryptography.SHA256]::Create()",
    "try { $hash = $sha.ComputeHash($signature.SignerCertificate.RawData) } finally { $sha.Dispose() }",
    "$actual = ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()",
    "if ($actual -ne $env:ARIADNE_EXPECTED_PUBLISHER) { throw 'authenticode_publisher_mismatch' }",
  ].join("; ");
  run(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      ARIADNE_VERIFY_HELPER: file,
      ARIADNE_EXPECTED_PUBLISHER: expectedPublisher,
    },
  );
}

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit ${String(result.status)}`);
  }
}
