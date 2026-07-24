import { describe, expect, it } from "vitest";

import { AgentProposalCapabilityPolicy } from "../src/assistant/AgentProposalCapabilityPolicy.js";
import type { AgentProposalDraft } from "../src/assistant/AgentProposalDraftContracts.js";
import { agentHandoffRunMode } from "../src/app/createAgentHandoffRuntime.js";

const broadDraft: AgentProposalDraft = {
  reason: "The request may need tools",
  interpretedTask: "Inspect the project and report the result",
  requestedCapabilities: ["file-read", "file-write", "browser", "shell"],
  risk: "destructive",
};

describe("AgentProposalCapabilityPolicy", () => {
it("preserves an explicit user read-only boundary", () => {
  const policy = new AgentProposalCapabilityPolicy({ permissionPolicy: "autoRun" });

  const normalized = policy.normalize({
    originalRequest: "Explain why startup is slow without changing code",
    draft: broadDraft,
  });

  expect(normalized.requestedCapabilities).toEqual(["file-read"]);
  expect(normalized.risk).toBe("read-only");
});

it("intersects structured capabilities with the host ceiling", () => {
  const policy = new AgentProposalCapabilityPolicy({ permissionPolicy: "autoEdit" });

  const normalized = policy.normalize({
    originalRequest: "Update the file and run its tests",
    draft: {
      ...broadDraft,
      interpretedTask: "修改项目文件，打开浏览器并运行测试",
      requestedCapabilities: ["file-write", "browser", "shell"],
      risk: "write",
    },
  });

  expect(normalized.requestedCapabilities).toEqual(["file-write"]);
  expect(normalized.risk).toBe("write");
});

it("does not preserve destructive risk for network-only access", () => {
  const policy = new AgentProposalCapabilityPolicy();

  const normalized = policy.normalize({
    originalRequest: "Browse the documentation",
    draft: {
      ...broadDraft,
      interpretedTask: "打开浏览器访问项目文档",
      requestedCapabilities: ["browser"],
    },
  });

  expect(normalized.requestedCapabilities).toEqual(["browser"]);
  expect(normalized.risk).toBe("write");
});

it("validates a terse continuation against its interpreted task", () => {
  const policy = new AgentProposalCapabilityPolicy({ permissionPolicy: "autoRun" });

  const normalized = policy.normalize({
    originalRequest: "开始实现",
    draft: {
      reason: "The approved task needs project files, dependencies, and a browser preview",
      interpretedTask:
        "创建项目目录，安装 Three.js 及相关依赖，编写 HTML/CSS/JS 代码实现可点击国家的 3D 地球，并打开浏览器预览。",
      requestedCapabilities: ["file-read", "file-write", "browser", "shell"],
      risk: "write",
    },
  });

  expect(normalized.requestedCapabilities).toEqual([
    "file-read",
    "file-write",
    "browser",
    "shell",
  ]);
  expect(normalized.risk).toBe("write");
});

it("does not downgrade a structured write request because wording is novel", () => {
  const policy = new AgentProposalCapabilityPolicy({ permissionPolicy: "autoRun" });

  const normalized = policy.normalize({
    originalRequest:
      "我需要实现一个3d的地球网页的项目，可以鼠标拖动地球进行旋转，可以选中任意地方显示国家信息",
    draft: {
      reason: "需要创建项目文件",
      interpretedTask: "创建一份可直接运行的3D地球HTML文件",
      requestedCapabilities: ["file-write"],
      risk: "write",
    },
  });

  expect(normalized.requestedCapabilities).toEqual(["file-write"]);
  expect(normalized.risk).toBe("write");
});

it("uses approved capabilities to deterministically select the Agent execution mode", () => {
  expect(agentHandoffRunMode(["read"])).toBe("review");
  expect(agentHandoffRunMode(["read", "network"])).toBe("debug");
  expect(agentHandoffRunMode(["read", "write", "shell"])).toBe("implement");
});
});
