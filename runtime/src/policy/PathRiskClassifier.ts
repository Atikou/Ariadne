import os from "node:os";
import path from "node:path";

export type PathRiskKind = "normal" | "sensitive_file" | "dangerous_path";

export interface PathRisk {
  kind: PathRiskKind;
  tier: "low" | "medium" | "high" | "critical";
  reasons: string[];
}

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "cookies",
  "token",
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function classifyPathRisk(targetPath: string): PathRisk {
  const full = path.resolve(targetPath);
  const lower = full.toLowerCase();
  const reasons: string[] = [];

  if (isSystemPath(lower)) {
    reasons.push("system_path");
  }
  if (isSensitivePath(lower)) {
    reasons.push("sensitive_file");
  }

  if (reasons.includes("system_path")) {
    return { kind: "dangerous_path", tier: "critical", reasons };
  }
  if (reasons.length > 0) {
    return { kind: "sensitive_file", tier: "high", reasons };
  }
  return { kind: "normal", tier: "low", reasons: [] };
}

function isSystemPath(lowerFullPath: string): boolean {
  const dangerousRoots =
    process.platform === "win32"
      ? [
          "c:\\windows",
          "c:\\program files",
          "c:\\program files (x86)",
          path.join(os.homedir(), "appdata").toLowerCase(),
        ]
      : ["/etc", "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/var/lib", "/var/run"];
  return dangerousRoots.some((root) => lowerFullPath === root || lowerFullPath.startsWith(`${root}${path.sep}`));
}

function isSensitivePath(lowerFullPath: string): boolean {
  const segments = lowerFullPath.split(/[\\/]+/);
  if (segments.includes(".ssh")) return true;
  const basename = path.basename(lowerFullPath);
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(lowerFullPath));
}
