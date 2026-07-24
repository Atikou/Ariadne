import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { canonicalizePathIdentity } from "./pathIdentity.js";

export type NativeDirectoryPickerResult =
  | { available: false; cancelled: true; reason: "unsupported_platform" }
  | { available: true; cancelled: true }
  | { available: true; cancelled: false; path: string };

export interface NativeProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type NativeProcessRunner = (file: string, args: readonly string[]) => Promise<NativeProcessResult>;

export class NativeDirectoryPickerBusyError extends Error {
  readonly code = "directory_picker_busy";

  constructor() {
    super("已有文件夹选择窗口正在等待操作");
  }
}

export class NativeDirectoryPickerFailedError extends Error {
  readonly code = "directory_picker_failed";

  constructor(message: string) {
    super(message);
  }
}

export class NativeDirectoryPicker {
  private active = false;
  private readonly platform: NodeJS.Platform;
  private readonly windowsDirectory: string;
  private readonly runner: NativeProcessRunner;

  constructor(options?: {
    platform?: NodeJS.Platform;
    windowsDirectory?: string;
    runner?: NativeProcessRunner;
  }) {
    this.platform = options?.platform ?? process.platform;
    this.windowsDirectory = options?.windowsDirectory ?? process.env.SystemRoot ?? "C:\\Windows";
    this.runner = options?.runner ?? runNativeProcess;
  }

  async pick(input?: { initialDirectory?: string }): Promise<NativeDirectoryPickerResult> {
    if (this.active) throw new NativeDirectoryPickerBusyError();
    if (this.platform !== "win32") {
      return { available: false, cancelled: true, reason: "unsupported_platform" };
    }

    this.active = true;
    try {
      const initialDirectory = await resolveExistingDirectory(input?.initialDirectory);
      const executable = path.join(
        this.windowsDirectory,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const args = [
        "-NoLogo",
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_FOLDER_PICKER_SCRIPT,
      ];
      if (initialDirectory) args.push(initialDirectory);
      const result = await this.runner(executable, args);
      if (result.code === 2) return { available: true, cancelled: true };
      if (result.code !== 0) {
        throw new NativeDirectoryPickerFailedError("无法打开文件夹选择窗口，请检查本机 PowerShell 与桌面会话状态");
      }

      const selected = lastNonEmptyLine(result.stdout);
      if (!selected) throw new NativeDirectoryPickerFailedError("文件夹选择窗口未返回有效路径");
      const canonical = await resolveExistingDirectory(selected);
      if (!canonical) throw new NativeDirectoryPickerFailedError("所选文件夹不存在或无法访问");
      return { available: true, cancelled: false, path: canonical };
    } finally {
      this.active = false;
    }
  }
}

const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '选择工作区文件夹'",
  "$dialog.ShowNewFolderButton = $true",
  "if ($args.Count -gt 0 -and (Test-Path -LiteralPath $args[0] -PathType Container)) {",
  "  $dialog.SelectedPath = (Resolve-Path -LiteralPath $args[0]).Path",
  "}",
  "$result = $dialog.ShowDialog()",
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::Out.WriteLine($dialog.SelectedPath)",
  "  exit 0",
  "}",
  "exit 2",
].join("; ");

async function resolveExistingDirectory(value?: string): Promise<string | undefined> {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) return undefined;
    return canonicalizePathIdentity(candidate);
  } catch {
    return undefined;
  }
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function runNativeProcess(file: string, args: readonly string[]): Promise<NativeProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length > 16_384 ? combined.slice(-16_384) : combined;
}
