import { describe, expect, it } from "vitest";

import type { UserPermissionPolicy } from "../src/agent/RunPolicyTypes.js";
import {
  AgentProposalCapabilityPolicy,
  permissionPolicyForPermissions,
} from "../src/assistant/AgentProposalCapabilityPolicy.js";
import type { AgentProposalDraft } from "../src/assistant/AgentProposalDraftContracts.js";
import type { ToolPermission } from "../src/core/permissions.js";

const projectChangeDraft: AgentProposalDraft = {
  reason: "The requested change needs project inspection, editing, and verification.",
  interpretedTask: "Inspect the current Ariadne workspace, update the requested files, and run verification.",
  requestedCapabilities: ["file-read", "file-write", "shell"],
  risk: "write",
};

describe("Ariadne proposal capability policy", () => {
  it.each<{
    policy: UserPermissionPolicy;
    expectedCapabilities: AgentProposalDraft["requestedCapabilities"];
    expectedRisk: AgentProposalDraft["risk"];
  }>([
    {
      policy: "readOnly",
      expectedCapabilities: ["file-read"],
      expectedRisk: "read-only",
    },
    {
      policy: "autoEdit",
      expectedCapabilities: ["file-read", "file-write"],
      expectedRisk: "write",
    },
    {
      policy: "confirmBeforeRun",
      expectedCapabilities: ["file-read", "file-write", "shell"],
      expectedRisk: "write",
    },
  ])(
    "intersects the structured proposal with the $policy ceiling",
    ({ policy, expectedCapabilities, expectedRisk }) => {
      const normalized = new AgentProposalCapabilityPolicy({
        permissionPolicy: policy,
      }).normalize({
        originalRequest: "Update the current project and verify the result.",
        draft: projectChangeDraft,
      });

      expect(normalized.requestedCapabilities).toEqual(expectedCapabilities);
      expect(normalized.risk).toBe(expectedRisk);
    },
  );

  it("treats an explicit no-change request as authoritative", () => {
    const normalized = new AgentProposalCapabilityPolicy({
      permissionPolicy: "autoRun",
    }).normalize({
      originalRequest: "Review the current project without changing files or running commands.",
      draft: projectChangeDraft,
    });

    expect(normalized.requestedCapabilities).toEqual(["file-read"]);
    expect(normalized.risk).toBe("read-only");
  });

  it("does not invent capabilities that are absent from the structured proposal", () => {
    const normalized = new AgentProposalCapabilityPolicy({
      permissionPolicy: "autoRun",
    }).normalize({
      originalRequest: "Investigate the failure and explain the likely cause.",
      draft: {
        ...projectChangeDraft,
        requestedCapabilities: ["file-read"],
        risk: "read-only",
      },
    });

    expect(normalized.requestedCapabilities).toEqual(["file-read"]);
    expect(normalized.risk).toBe("read-only");
  });

  it.each<{
    permissions: ToolPermission[];
    expected: UserPermissionPolicy;
  }>([
    { permissions: ["read"], expected: "readOnly" },
    { permissions: ["read", "write"], expected: "confirmBeforeEdit" },
    { permissions: ["read", "network"], expected: "confirmBeforeRun" },
    { permissions: ["read", "shell"], expected: "confirmBeforeRun" },
  ])(
    "derives $expected from $permissions",
    ({ permissions, expected }) => {
      expect(permissionPolicyForPermissions(permissions)).toBe(expected);
    },
  );
});
