import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfigSchema, type AppConfig } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Ariadne Runtime 根：dist/.. 或 src/.. 都退到 runtime（可运行代码）根目录。 */
const projectRoot = path.resolve(moduleDir, "..", "..");

export interface LoadConfigOptions {
  /** profile 名（对应 config/<profile>.json）。默认读 AGENT_PROFILE 或 "default"。 */
  profile?: string;
  /** Runtime 安装根；桌面宿主必须显式注入，源码/CLI 模式可省略。 */
  projectRoot?: string;
  /** 已由宿主构造并校验的配置；提供后不再读取安装树中的 profile 文件。 */
  config?: AppConfig;
}

export interface LoadedConfig {
  profile: string;
  config: AppConfig;
  /** 已解析为绝对路径的工作区根。 */
  workspaceRoot: string;
  /** 已解析为绝对路径的内嵌模型目录。 */
  modelsDirectory: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const profile = options.profile ?? process.env.AGENT_PROFILE ?? "default";
  const resolvedProjectRoot = path.resolve(options.projectRoot ?? projectRoot);
  const configPath = path.join(resolvedProjectRoot, "config", `${profile}.json`);

  let raw: unknown = options.config;
  if (!raw) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (error) {
      throw new Error(`无法读取配置文件 ${configPath}：${String(error)}`);
    }
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置文件校验失败 ${configPath}：\n${parsed.error.toString()}`);
  }

  const config = parsed.data;
  const workspaceRoot = path.resolve(resolvedProjectRoot, config.workspaceRoot);
  const modelsDirectory = path.resolve(resolvedProjectRoot, config.models.directory);

  return { profile, config, workspaceRoot, modelsDirectory };
}
