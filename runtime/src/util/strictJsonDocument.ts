/** Parse exactly one JSON document. Markdown fences, prose prefixes and trailing text are protocol errors. */
export function parseStrictJsonDocument(text: string, label: string): unknown {
  const document = text.trim();
  if (!document) throw new Error(`${label}为空，预期单个 JSON 文档`);
  try {
    return JSON.parse(document);
  } catch {
    throw new Error(`${label}不是单个合法 JSON 文档`);
  }
}
