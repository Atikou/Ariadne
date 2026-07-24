import { describe, expect, it } from "vitest";

import type { UserPermissionPolicy } from "../src/agent/RunPolicyTypes.js";
import {
  agentHandoffRunMode,
  preauthorizedHandoffPermissions,
} from "../src/app/createAgentHandoffRuntime.js";
import type { ToolPermission } from "../src/core/permissions.js";

describe("Ariadne handoff authorization", () => {
  const permissionCeiling: ToolPermission[] = [
    "read",
    "write",
    "shell",
    "network",
    "dangerous",
  ];

  it.each<{
    policy: UserPermissionPolicy;
    expected: ToolPermission[];
  }>([
    { policy: "readOnly", expected: ["read"] },
    { policy: "confirmBeforeEdit", expected: ["read"] },
    { policy: "confirmBeforeRun", expected: ["read"] },
    { policy: "autoEdit", expected: ["read", "write"] },
    { policy: "autoRun", expected: permissionCeiling },
  ])(
    "preauthorizes only the subset allowed by $policy",
    ({ policy, expected }) => {
      expect(preauthorizedHandoffPermissions(permissionCeiling, policy)).toEqual(expected);
    },
  );

  it("never widens a one-time permission ceiling", () => {
    const limitedCeiling: ToolPermission[] = ["read", "network"];

    expect(preauthorizedHandoffPermissions(limitedCeiling, "autoEdit")).toEqual(["read"]);
    expect(preauthorizedHandoffPermissions(limitedCeiling, "autoRun")).toEqual(limitedCeiling);
  });

  it.each<{
    permissions: ToolPermission[];
    expectedMode: "implement" | "debug" | "review";
  }>([
    { permissions: ["read"], expectedMode: "review" },
    { permissions: ["read", "network"], expectedMode: "debug" },
    { permissions: ["read", "shell"], expectedMode: "debug" },
    { permissions: ["read", "write"], expectedMode: "implement" },
  ])(
    "selects $expectedMode for $permissions",
    ({ permissions, expectedMode }) => {
      expect(agentHandoffRunMode(permissions)).toBe(expectedMode);
    },
  );
});
