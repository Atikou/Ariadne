import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..", "..");

/**
 * 在入口处尽早调用：若存在项目根目录 .env 则载入到 process.env。
 * 使用 Node 内置 process.loadEnvFile（Node 20.12+ / 22），无需 dotenv 依赖。
 * 已存在的系统环境变量优先级更高时由调用方保证（loadEnvFile 不覆盖已存在的值之外的行为以 Node 实现为准）。
 */
export function loadEnvFile(): void {
  const envPath = path.join(projectRoot, ".env");
  try {
    process.loadEnvFile(envPath);
  } catch {
    // .env 不存在或不可读时静默跳过，回退到进程已有的环境变量。
  }
}
