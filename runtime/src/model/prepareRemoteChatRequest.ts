import { detectSensitiveString, redactString } from "../util/redact.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ChatRequest, ModelClient } from "./types.js";

/** 远程模型调用前脱敏 prompt（与 legacy ModelRouter 行为一致）。 */
export function prepareRemoteChatRequest(
  request: ChatRequest,
  client: Pick<ModelClient, "name" | "model" | "location">,
  trace?: TraceLogger,
): ChatRequest {
  if (client.location !== "remote") return request;
  let redactedCount = 0;
  const messages = request.messages.map((message) => {
    if (detectSensitiveString(message.content).length === 0) return message;
    redactedCount += 1;
    return { ...message, content: redactString(message.content) };
  });
  if (redactedCount === 0) return request;
  trace?.write({
    type: "model_prompt_redacted",
    client: client.name,
    model: client.model,
    location: client.location,
    redactedMessages: redactedCount,
  });
  return { ...request, messages };
}
