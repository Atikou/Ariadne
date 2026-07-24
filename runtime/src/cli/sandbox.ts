import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/loadConfig.js";
import { createWindowsNativeSandbox } from "../sandbox/createProcessSandbox.js";
import { loadEnvFile } from "../util/env.js";
import { createSandboxMaintenanceAuditSink } from "./sandboxTrace.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runSandboxCli(args: string[]): Promise<void> {
  loadEnvFile();
  const command = args[0];
  if (command === "--help" || command === "-h" || !command) {
    printUsage();
    return;
  }
  if (args.length !== 1 || (command !== "status" && command !== "setup")) {
    console.error(`未知沙箱命令：${args.join(" ")}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { config, workspaceRoot } = loadConfig();
  const audit = createSandboxMaintenanceAuditSink(path.join(packageRoot, "data", "traces"));
  const sandbox = createWindowsNativeSandbox(config.security, packageRoot, audit);
  const result = command === "setup"
    ? await sandbox.setup(workspaceRoot)
    : await sandbox.status(workspaceRoot);
  console.log(JSON.stringify(result, null, 2));
  if (command === "setup" && result.status !== "ready") process.exitCode = 2;
  if (result.status === "error" || result.status === "unsupported") process.exitCode = 1;
}

function printUsage(): void {
  console.log(`用法：
  npm run sandbox:status
  npm run sandbox:setup

setup 会构建 Windows Helper，并在需要系统级初始化时请求 UAC。`);
}

runSandboxCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
