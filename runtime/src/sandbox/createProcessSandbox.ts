import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SecurityConfig } from "../config/types.js";
import type { SandboxAuditSink } from "./SandboxAudit.js";
import { HostProcessSandbox } from "./HostProcessSandbox.js";
import type { ProcessSandbox } from "./ProcessSandbox.js";
import { WindowsNativeSandbox } from "./WindowsNativeSandbox.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function createProcessSandbox(
  security: SecurityConfig | undefined,
  projectRoot: string,
  audit?: SandboxAuditSink,
  options: { requireTrustedHelper?: boolean } = {},
): ProcessSandbox {
  const config = security?.sandbox;
  const mode = config?.mode ?? "workspace-write";
  if (mode === "danger-full-access") return new HostProcessSandbox();
  return createWindowsNativeSandbox(security, projectRoot, audit, options);
}

export function createWindowsNativeSandbox(
  security: SecurityConfig | undefined,
  projectRoot: string,
  audit?: SandboxAuditSink,
  options: { requireTrustedHelper?: boolean } = {},
): WindowsNativeSandbox {
  const config = security?.sandbox;
  const mode = config?.mode ?? "workspace-write";
  if (mode === "danger-full-access") {
    throw new Error("native_sandbox_requires_restricted_mode");
  }
  if (process.platform !== "win32") {
    throw new Error("native_sandbox_unsupported_platform");
  }

  const resolveFromProject = (value: string): string =>
    path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  return new WindowsNativeSandbox({
    helperPath: config?.helperPath
      ? resolveFromProject(config.helperPath)
      : path.join(packageRoot, ".runtime", "windows-sandbox", "Ariadne.WindowsSandbox.exe"),
    stateRoot: config?.stateRoot
      ? resolveFromProject(config.stateRoot)
      : path.join(
          process.env.ProgramData ?? `${process.env.SystemDrive ?? "C:"}\\ProgramData`,
          "Ariadne",
          "sandbox",
        ),
    mode,
    writableRoots: (config?.writableRoots ?? []).map(resolveFromProject),
    toolReadRoots: discoverWindowsSandboxToolReadRoots(
      (config?.toolReadRoots ?? []).map(resolveFromProject),
    ),
    readOnlySubpaths: (config?.readOnlySubpaths ?? []).map(resolveFromProject),
    allowLoopback: config?.allowLoopback,
    resourceLimits: config?.resourceLimits,
    offlineUser: config?.offlineUser,
    onlineUser: config?.onlineUser,
    writerGroup: config?.writerGroup,
    helperTrustMode: options.requireTrustedHelper
      ? "trusted_distribution"
      : "development",
    ...(options.requireTrustedHelper
      ? { trustedApplicationRoot: projectRoot }
      : {}),
    audit,
  });
}

export function discoverWindowsSandboxToolReadRoots(configuredRoots: string[]): string[] {
  const candidates = [
    ...configuredRoots,
    path.dirname(process.execPath),
    path.join(packageRoot, ".runtime", "transformers"),
    path.join(packageRoot, ".runtime", "python"),
  ];
  const gitExecutable = findExecutableOnPath("git.exe");
  if (gitExecutable) {
    const executableDirectory = path.dirname(gitExecutable);
    candidates.push(
      ["cmd", "bin"].includes(path.basename(executableDirectory).toLowerCase())
        ? path.dirname(executableDirectory)
        : executableDirectory,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function findExecutableOnPath(name: string): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
