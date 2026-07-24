export type RiskLevel = "safe" | "caution" | "dangerous";

export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
}

/** 直接拦截的高危命令模式（不可执行）。 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: "递归强制删除 (rm -rf)" },
  { re: /\brm\s+-[a-z]*r[a-z]*\s+[\/~]/i, reason: "删除根/家目录" },
  { re: /\bdel\s+\/[sf]/i, reason: "Windows 强制递归删除 (del /s /f)" },
  { re: /\brmdir\s+\/s/i, reason: "Windows 递归删除目录" },
  { re: /\bformat\s+[a-z]:/i, reason: "格式化磁盘" },
  { re: /\bmkfs\b/i, reason: "格式化文件系统" },
  { re: /\bdd\s+if=/i, reason: "dd 裸写设备" },
  { re: />\s*\/dev\/sd[a-z]/i, reason: "覆盖块设备" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "关机/重启" },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, reason: "fork 炸弹" },
  { re: /\bgit\s+push\b.*(--force\b|-f\b)/i, reason: "强制推送 (git push --force)" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|powershell|pwsh|cmd)\b/i, reason: "下载后直接执行脚本" },
  { re: /\bnpm\s+publish\b/i, reason: "发布 npm 包" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "硬重置工作区 (git reset --hard)" },
  { re: /\bgit\s+clean\s+(-[a-z]*f|--force)/i, reason: "强制清理未跟踪文件 (git clean -fd)" },
];

/** 提示需谨慎（仍可执行，但建议确认）的模式。 */
const CAUTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\b/i, reason: "删除文件" },
  { re: /\bdel\b/i, reason: "删除文件" },
  { re: /\bgit\s+clean\b/i, reason: "清理未跟踪文件" },
  { re: /\bgit\s+checkout\s+--?\s*\./i, reason: "丢弃本地改动" },
  { re: /\b(npm|pnpm|yarn)\s+(install|add|i)\b/i, reason: "安装依赖（联网）" },
  { re: /\bmv\b|\bmove\b/i, reason: "移动/覆盖文件" },
  { re: />[^>]/, reason: "重定向覆盖文件" },
];

/** 评估命令风险等级。dangerous 应被拦截，caution 建议确认。 */
export function checkCommandRisk(command: string): RiskVerdict {
  const cmd = command.trim();
  if (!cmd) return { level: "safe", reason: "空命令" };

  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { level: "dangerous", reason };
  }
  for (const { re, reason } of CAUTION_PATTERNS) {
    if (re.test(cmd)) return { level: "caution", reason };
  }
  return { level: "safe", reason: "未匹配到风险模式" };
}
