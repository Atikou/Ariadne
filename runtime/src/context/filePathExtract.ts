/** 从自由文本中提取疑似工作区相对路径。 */
export function extractFilePathsFromText(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:src|tests|docs|config|public)\/[\w./-]+\.\w{1,8}\b/gi,
    /`((?:src|tests|docs|config)[/\\][\w./\\-]+\.\w{1,8})`/gi,
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).replace(/\\/g, "/").trim();
      if (isLikelyWorkspaceFile(raw)) found.add(normalizeWorkspacePath(raw));
    }
  }
  return [...found];
}

export function normalizeWorkspacePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isLikelyWorkspaceFile(filePath: string): boolean {
  const p = normalizeWorkspacePath(filePath);
  if (!p || p.includes("..") || p.startsWith("/") || /^[a-z]:/i.test(p)) return false;
  if (/^(src|tests|docs|config|public)\//.test(p)) return true;
  return /^[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/i.test(p);
}
