import {
  getLlama,
  LlamaChatSession,
  type ChatHistoryItem,
  type Llama,
  type LlamaContext,
  type LlamaModel,
} from "node-llama-cpp";
import path from "node:path";

import type {
  RuntimeEventMessage,
  RuntimeCountTokensPayload,
  RuntimeCountTokensResult,
  RuntimeGeneratePayload,
  RuntimeGenerateResult,
  RuntimeLoadPayload,
  RuntimeRequestMessage,
} from "../runtimeProtocol.js";
import { withOwnedLlamaChatSession } from "../withOwnedLlamaChatSession.js";

let llama: Llama | undefined;
let model: LlamaModel | undefined;
let context: LlamaContext | undefined;
let loadedModelId: string | undefined;
const abortControllers = new Map<string, AbortController>();
let queue = Promise.resolve();

process.on("message", (raw: unknown) => {
  const message = raw as RuntimeRequestMessage;
  if (!message || typeof message.id !== "string") return;
  if (message.command === "cancel") {
    abortControllers.get(message.id)?.abort("parent_cancelled");
    return;
  }
  queue = queue.then(() => handle(message)).catch((error) => sendError(message.id, error));
});

async function handle(message: RuntimeRequestMessage): Promise<void> {
  switch (message.command) {
    case "ping":
      send({ id: message.id, type: "result", result: { ok: true } });
      return;
    case "load":
      await load(message.payload as RuntimeLoadPayload);
      send({ id: message.id, type: "result", result: { loadedModelId } });
      return;
    case "count_tokens":
      countTokens(message.id, message.payload as RuntimeCountTokensPayload);
      return;
    case "generate":
      await generate(message.id, message.payload as RuntimeGeneratePayload);
      return;
    case "unload":
      await unload();
      send({ id: message.id, type: "result" });
      return;
    case "dispose":
      await unload();
      send({ id: message.id, type: "result" });
      process.disconnect?.();
      return;
    default:
      throw new Error(`未知 llama.cpp worker 命令：${message.command}`);
  }
}

function countTokens(id: string, input: RuntimeCountTokensPayload): void {
  if (!model || !loadedModelId) throw new Error("llama.cpp 模型尚未加载");
  const toolSchema = input.tools?.length ? `\ntools:${JSON.stringify(input.tools)}` : "";
  const result: RuntimeCountTokensResult = {
    tokens: model.tokenize(`${renderMessages(input.messages)}${toolSchema}`).length,
    tokenizer: `llama.cpp:${loadedModelId}`,
  };
  send({ id, type: "result", result });
}

async function load(input: RuntimeLoadPayload): Promise<void> {
  if (loadedModelId === input.modelId && model && context) return;
  await unload();
  const gpu = input.device === "cpu" ? false : input.device ?? "auto";
  const configuredTempRoot = process.env.ARIADNE_MODEL_TEMP_ROOT;
  const tempDir =
    configuredTempRoot && path.isAbsolute(configuredTempRoot)
      ? configuredTempRoot
      : undefined;
  llama = await getLlama({
    gpu,
    build: "never",
    skipDownload: true,
    progressLogs: false,
    ...(tempDir ? { tempDir } : {}),
  });
  model = await llama.loadModel({
    modelPath: input.modelPath,
    gpuLayers: input.gpuLayers ?? "auto",
    useMmap: "auto",
  });
  context = await model.createContext({
    contextSize: input.contextSize ?? "auto",
  });
  loadedModelId = input.modelId;
}

async function generate(id: string, input: RuntimeGeneratePayload): Promise<void> {
  if (!model || !context || !loadedModelId) throw new Error("llama.cpp 模型尚未加载");
  const activeModel = model;
  const activeContext = context;
  const controller = new AbortController();
  abortControllers.set(id, controller);
  try {
    await withOwnedLlamaChatSession(
      () => activeContext.getSequence(),
      (sequence) =>
        new LlamaChatSession({
          contextSequence: sequence,
          autoDisposeSequence: true,
        }),
      async (session) => {
        const { history, prompt } = toChatHistory(input.messages);
        session.setChatHistory(history);
        const meta = await session.promptWithMeta(prompt, {
          signal: controller.signal,
          stopOnAbortSignal: true,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
          onTextChunk: (delta) => send({ id, type: "token", delta }),
        });
        const result: RuntimeGenerateResult = {
          content: meta.responseText,
          inputTokens: activeModel.tokenize(renderMessages(input.messages)).length,
          outputTokens: activeModel.tokenize(meta.responseText).length,
        };
        send({ id, type: "result", result });
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      send({ id, type: "cancelled" });
      return;
    }
    throw error;
  } finally {
    abortControllers.delete(id);
  }
}

function toChatHistory(messages: RuntimeGeneratePayload["messages"]): {
  history: ChatHistoryItem[];
  prompt: string;
} {
  let promptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i]?.role;
    if (role === "user" || role === "tool") {
      promptIndex = i;
      break;
    }
  }
  const promptMessage = promptIndex >= 0 ? messages[promptIndex] : undefined;
  const history: ChatHistoryItem[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (i === promptIndex) continue;
    const message = messages[i];
    if (!message) continue;
    if (message.role === "system") history.push({ type: "system", text: message.content });
    else if (message.role === "assistant") history.push({ type: "model", response: [message.content] });
    else history.push({ type: "user", text: renderUserMessage(message) });
  }
  return {
    history,
    prompt: promptMessage ? renderUserMessage(promptMessage) : "请根据以上上下文继续回答。",
  };
}

function renderUserMessage(message: RuntimeGeneratePayload["messages"][number]): string {
  return message.role === "tool"
    ? `[工具结果${message.name ? ` ${message.name}` : ""}]\n${message.content}`
    : message.content;
}

function renderMessages(messages: RuntimeGeneratePayload["messages"]): string {
  return messages.map((item) => `${item.role}: ${item.content}`).join("\n");
}

async function unload(): Promise<void> {
  abortControllers.forEach((controller) => controller.abort("runtime_unload"));
  abortControllers.clear();
  await context?.dispose();
  context = undefined;
  await model?.dispose();
  model = undefined;
  await llama?.dispose();
  llama = undefined;
  loadedModelId = undefined;
}

function send(message: RuntimeEventMessage): void {
  process.send?.(message);
}

function sendError(id: string, error: unknown): void {
  // Worker 协议不得把本机堆栈和绝对路径发送到 API/UI；详细堆栈由进程内 trace 记录。
  send({ id, type: "error", error: error instanceof Error ? error.message : String(error) });
}
