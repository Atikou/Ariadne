import { normalizePermissionTarget, type ScopedApprovedPermissions } from "./permissionRequestTypes.js";

export function isPathApproved(path: string | undefined, allowedPaths: string[] | undefined): boolean {
  if (!path || !allowedPaths?.length) return false;
  const normalized = normalizePermissionTarget(path);
  return allowedPaths.some((allowed) => {
    const pattern = normalizePermissionTarget(allowed);
    if (pattern === normalized) return true;
    if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
      const prefix = pattern.replace(/\/\*+$/, "");
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized.endsWith(`/${pattern}`) || normalized === pattern;
  });
}

export function isCommandApproved(command: string | undefined, allowedCommands: string[] | undefined): boolean {
  if (!command || !allowedCommands?.length) return false;
  const normalized = command.trim();
  return allowedCommands.some((allowed) => allowed.trim() === normalized);
}

export function isToolCallGranted(input: {
  toolName: string;
  permission: string;
  toolInput: unknown;
  grants?: ScopedApprovedPermissions;
}): boolean {
  const grants = input.grants;
  if (!grants) return false;
  const record =
    input.toolInput && typeof input.toolInput === "object" && !Array.isArray(input.toolInput)
      ? (input.toolInput as Record<string, unknown>)
      : {};

  if (input.permission === "write") {
    const path = readString(record.path) ?? readString(record.file);
    return isPathApproved(path, grants.write_file);
  }

  if (input.permission === "shell") {
    const command = readString(record.command);
    return isCommandApproved(command, grants.shell);
  }

  if (input.permission === "network") {
    const target =
      readString(record.url)
      ?? readString(record.endpoint)
      ?? readString(record.command);
    return isPathApproved(target, grants.network);
  }

  if (input.permission === "dangerous") {
    const command = readString(record.command);
    const path = readString(record.path);
    return (
      isCommandApproved(command, grants.dangerous) ||
      isPathApproved(path, grants.dangerous)
    );
  }

  return false;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
