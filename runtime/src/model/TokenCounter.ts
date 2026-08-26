import type { TokenCount, TokenCounter } from "./types.js";

export type { TokenCount, TokenCounter } from "./types.js";

export function createConservativeTokenCounter(profile: string): TokenCounter {
  const result = (tokens: number): TokenCount => ({
    tokens: Math.max(1, tokens),
    exact: false,
    method: "provider_profile_conservative",
    tokenizer: profile,
  });
  return {
    profile,
    exact: false,
    async countText(text) {
      return result(conservativeTextTokens(text));
    },
    async countMessages(messages) {
      return result(messages.reduce(
        (total, message) => total + 6 + conservativeTextTokens(message.content),
        2,
      ));
    },
    async countTools(tools) {
      return result(tools.length === 0
        ? 0
        : 8 + conservativeTextTokens(JSON.stringify(tools)));
    },
    async countRequest(request) {
      const messages = await this.countMessages(request.messages);
      const tools = await this.countTools(request.tools ?? []);
      return result(messages.tokens + tools.tokens);
    },
  };
}

export function conservativeTextTokens(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  const nonAscii = [...text].filter((character) => character.codePointAt(0)! > 0x7f).length;
  return Math.max(1, Math.ceil(bytes / 3) + Math.ceil(nonAscii / 4));
}

export function remoteTokenizerProfile(providerId: string, model: string): string {
  const normalized = model.toLowerCase();
  if (providerId === "openai" || providerId === "openai-compatible") {
    return /^(gpt-4o|gpt-4\.1|o[134]|chatgpt-4o)/u.test(normalized)
      ? "openai:o200k_base:conservative"
      : "openai:cl100k_base:conservative";
  }
  if (providerId === "anthropic") return `anthropic:${normalized}:conservative`;
  return `${providerId}:${normalized}:conservative`;
}
