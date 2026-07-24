import readline from "node:readline";

import { HeadlessRuntimeHost } from "../transport/HeadlessRuntimeHost.js";

for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  console[method] = (...values: unknown[]) => {
    process.stderr.write(`${values.map((value) =>
      typeof value === "string" ? value : JSON.stringify(value)).join(" ")}\n`);
  };
}

const once = process.argv.slice(2).includes("--once");
const host = new HeadlessRuntimeHost({ once });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!await host.handleLine(line)) break;
}
lines.close();
await host.closeInput();
process.exit(host.exitCode);
