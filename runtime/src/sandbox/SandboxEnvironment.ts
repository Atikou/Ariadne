export const SANDBOX_ENVIRONMENT_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "TERM",
  "LANG",
  "LC_ALL",
]);

export function isSandboxEnvironmentVariableAllowed(name: string): boolean {
  return SANDBOX_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase());
}

export function filterSandboxEnvironment(
  source: NodeJS.ProcessEnv,
  additions: Readonly<Record<string, string>> | undefined = undefined,
): NodeJS.ProcessEnv {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (value !== undefined && SANDBOX_ENVIRONMENT_ALLOWLIST.has(normalized)) {
      values.set(normalized, value);
    }
  }
  for (const [name, value] of Object.entries(additions ?? {})) {
    const normalized = name.toUpperCase();
    if (!SANDBOX_ENVIRONMENT_ALLOWLIST.has(normalized)) {
      throw new Error(`sandbox_environment_key_not_allowed:${name}`);
    }
    values.set(normalized, value);
  }
  return Object.fromEntries(values);
}
