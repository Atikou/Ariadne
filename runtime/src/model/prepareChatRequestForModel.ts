import type { ChatMessage, ChatRequest, ModelClient } from "./types.js";

export interface PreparedChatBudget {
  request: ChatRequest;
  inputTokens: number;
  outputReserve: number;
  toolSchemaTokens: number;
  droppedMessageCount: number;
  exact: boolean;
  tokenizer: string;
}

export async function prepareChatRequestForModel(
  request: ChatRequest,
  client: ModelClient,
): Promise<PreparedChatBudget> {
  const outputReserve = request.maxTokens ?? 1_024;
  const toolCount = await client.tokenCounter.countTools(request.tools ?? []);
  if (!client.contextWindowTokens) {
    const counted = await client.tokenCounter.countRequest(request);
    return {
      request,
      inputTokens: counted.tokens,
      outputReserve,
      toolSchemaTokens: toolCount.tokens,
      droppedMessageCount: 0,
      exact: counted.exact,
      tokenizer: counted.tokenizer,
    };
  }

  const inputBudget = client.contextWindowTokens - outputReserve;
  if (inputBudget <= toolCount.tokens) {
    throw new Error("context_budget_exceeded:tool_schema_and_output_reserve");
  }
  const essentialIndices = essentialMessageIndices(request.messages);
  const selected = new Set(essentialIndices);
  const essential = request.messages.filter((_, index) => selected.has(index));
  const essentialCount = await client.tokenCounter.countMessages(essential);
  let used = essentialCount.tokens + toolCount.tokens;
  if (used > inputBudget) {
    throw new Error("context_budget_exceeded:essential_messages");
  }

  const candidates = request.messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => !selected.has(index))
    .sort((a, b) => messageValue(b.message, b.index) - messageValue(a.message, a.index));
  for (const candidate of candidates) {
    const count = await client.tokenCounter.countMessages([candidate.message]);
    if (used + count.tokens > inputBudget) continue;
    selected.add(candidate.index);
    used += count.tokens;
  }
  const messages = request.messages.filter((_, index) => selected.has(index));
  const finalCount = await client.tokenCounter.countRequest({
    messages,
    tools: request.tools,
  });
  if (finalCount.tokens + outputReserve > client.contextWindowTokens) {
    throw new Error("context_budget_exceeded:tokenizer_final_check");
  }
  return {
    request: { ...request, messages },
    inputTokens: finalCount.tokens,
    outputReserve,
    toolSchemaTokens: toolCount.tokens,
    droppedMessageCount: request.messages.length - messages.length,
    exact: finalCount.exact,
    tokenizer: finalCount.tokenizer,
  };
}

function essentialMessageIndices(messages: readonly ChatMessage[]): number[] {
  const indices = new Set<number>();
  const firstSystem = messages.findIndex((message) => message.role === "system");
  if (firstSystem >= 0) indices.add(firstSystem);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      indices.add(index);
      break;
    }
  }
  return [...indices];
}

function messageValue(message: ChatMessage, index: number): number {
  const recency = index * 10;
  switch (message.role) {
    case "user": return 4_000 + recency;
    case "tool": return 3_000 + recency;
    case "system": return 2_000 + recency;
    case "assistant": return 1_000 + recency;
  }
}
