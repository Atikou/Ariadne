import { z } from "zod";

import { StaticToolProvider } from "./ToolProvider.js";
import type { ToolContract, ToolContext } from "./types.js";

const BROWSER_PROVIDER_ID = "browser-main";
const browserOutput = z.record(z.string(), z.unknown());
const browserResourcePayload = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  dataBase64: z.string().max(40_000_000),
}).strict();
const browserHttpsUrl = z.string().url().refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  },
  { message: "Browser URLs must use HTTPS without embedded credentials." },
);
const navigateInput = z.object({ url: browserHttpsUrl }).strict();
const emptyInput = z.object({}).strict();
const clickInput = z.object({ selector: z.string().min(1).max(2_048) }).strict();
const typeInput = z.object({
  selector: z.string().min(1).max(2_048),
  text: z.string().max(100_000),
  sensitive: z.boolean().default(false),
}).strict();
const scrollInput = z.object({
  deltaX: z.number().finite().min(-100_000).max(100_000).default(0),
  deltaY: z.number().finite().min(-100_000).max(100_000),
}).strict();
const waitInput = z.object({ milliseconds: z.number().int().min(0).max(30_000) }).strict();
const downloadInput = z.object({ url: browserHttpsUrl }).strict();
const browserContract = {
  version: "1.0.0",
  outputSchema: browserOutput,
  permissions: ["network"],
  resourceScopes: ["browser", "network"],
  effects: ["unknown"],
  risk: "high",
  parallelism: "serial",
  idempotency: "non_idempotent",
  dataSensitivity: "sensitive",
  egress: ["model", "network"],
  timeoutMs: 30_000,
  supportsResume: false,
  providerId: BROWSER_PROVIDER_ID,
} as const;

export const browserNavigateTool: ToolContract<typeof navigateInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_navigate",
  description: "Navigate the isolated web browser to an approved HTTPS URL.",
  inputSchema: navigateInput,
  async execute(input, context) {
    return requestBrowser(context, { kind: "browser.navigate", url: input.url });
  },
};

export const browserAccessibilitySnapshotTool: ToolContract<typeof emptyInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_accessibility_snapshot",
  description: "Read a bounded accessibility-oriented snapshot of the current page.",
  inputSchema: emptyInput,
  permissions: ["read"],
  effects: ["none"],
  risk: "medium",
  idempotency: "idempotent",
  async execute(_input, context) {
    return requestBrowser(context, { kind: "browser.accessibility_snapshot" });
  },
};

export const browserScreenshotTool: ToolContract<typeof emptyInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_screenshot",
  description: "Capture the current isolated page as a PNG Resource.",
  inputSchema: emptyInput,
  permissions: ["read"],
  effects: ["none"],
  risk: "medium",
  idempotency: "idempotent",
  async execute(_input, context) {
    return requestBrowserResource(context, { kind: "browser.screenshot" }, "browser-screenshot");
  },
};

export const browserClickTool: ToolContract<typeof clickInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_click",
  description: "Click an approved CSS selector in the isolated page.",
  inputSchema: clickInput,
  async execute(input, context) {
    return requestBrowser(context, { kind: "browser.click", selector: input.selector });
  },
};

export const browserTypeTool: ToolContract<typeof typeInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_type",
  description: "Type text into an approved selector; sensitive text is never echoed in audit output.",
  inputSchema: typeInput,
  async execute(input, context) {
    return requestBrowser(context, { kind: "browser.type", ...input });
  },
};

export const browserScrollTool: ToolContract<typeof scrollInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_scroll",
  description: "Scroll the isolated page.",
  inputSchema: scrollInput,
  async execute(input, context) {
    return requestBrowser(context, { kind: "browser.scroll", ...input });
  },
};

export const browserWaitTool: ToolContract<typeof waitInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_wait",
  description: "Wait for a bounded period while the isolated page settles.",
  inputSchema: waitInput,
  permissions: ["read"],
  effects: ["none"],
  risk: "low",
  idempotency: "idempotent",
  async execute(input, context) {
    return requestBrowser(context, { kind: "browser.wait", ...input });
  },
};

export const browserDownloadTool: ToolContract<typeof downloadInput, Record<string, unknown>> = {
  ...browserContract,
  name: "browser_download",
  description: "Download an approved HTTPS resource into the Resource Registry.",
  inputSchema: downloadInput,
  async execute(input, context) {
    return requestBrowserResource(
      context,
      { kind: "browser.download", url: input.url },
      input.url,
      60_000,
    );
  },
};

export const BROWSER_TOOLS = [
  browserNavigateTool,
  browserAccessibilitySnapshotTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserScrollTool,
  browserWaitTool,
  browserDownloadTool,
];

export function createBrowserToolProvider(): StaticToolProvider {
  return new StaticToolProvider(BROWSER_PROVIDER_ID, BROWSER_TOOLS);
}

async function requestBrowserResource(
  context: ToolContext,
  operation: Parameters<NonNullable<ToolContext["hostCapabilities"]>["request"]>[0],
  sourceId: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  if (!context.resources) throw new Error("resource_registry_unavailable");
  const response = browserResourcePayload.parse(
    await requestBrowser(context, operation, timeoutMs),
  );
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(response.dataBase64)) {
    throw new Error("browser_resource_base64_invalid");
  }
  const bytes = Buffer.from(response.dataBase64, "base64");
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("browser_resource_too_large");
  const owner = context.requestId
    ? { type: "run", id: context.requestId }
    : context.sessionId
      ? { type: "session", id: context.sessionId }
      : { type: "runtime", id: "runtime" };
  const resource = await context.resources.registerBytes({
    name: response.name,
    mediaType: response.mediaType,
    bytes,
    owner,
    lifecycle: context.requestId ? "run" : context.sessionId ? "session" : "temporary",
    sensitivity: "sensitive",
    provenance: {
      origin: "browser",
      sourceId,
      summary: operation.kind,
    },
  });
  return { resource };
}

async function requestBrowser(
  context: ToolContext,
  operation: Parameters<NonNullable<ToolContext["hostCapabilities"]>["request"]>[0],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  if (!context.hostCapabilities) throw new Error("browser_host_capability_unavailable");
  return context.hostCapabilities.request(operation, timeoutMs);
}
