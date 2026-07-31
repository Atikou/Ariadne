import { describe, expect, it } from "vitest";

import { assessWorkflowWriteGate } from "../src/agent/WorkflowWriteGate.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

describe("WorkflowWriteGate greenfield evidence", () => {
  it("accepts an executed absent-target observation before generating new files", () => {
    const gate = assessWorkflowWriteGate({
      intent: "generate_file",
      goal: "Create examples/todo-app in this codebase",
      tool: "write_file",
      hasProposal: true,
      steps: [absentTargetStep()],
    });

    expect(gate).toMatchObject({
      blocked: false,
      phase: "write",
      readToolsBeforeWrite: 1,
      priorWrites: 0,
    });
  });

  it("does not treat absent-target evidence as permission to edit an existing file", () => {
    const gate = assessWorkflowWriteGate({
      intent: "edit",
      goal: "Edit examples/todo-app/index.html",
      tool: "write_file",
      hasProposal: true,
      steps: [absentTargetStep()],
    });

    expect(gate).toMatchObject({
      blocked: true,
      readToolsBeforeWrite: 0,
      priorWrites: 0,
    });
  });

  it("never treats a blocked or crashed read as greenfield evidence", () => {
    const blocked = assessWorkflowWriteGate({
      intent: "generate_file",
      goal: "Create examples/todo-app in this codebase",
      tool: "write_file",
      hasProposal: true,
      steps: [{
        ...absentTargetStep(),
        executed: false,
        blocked: true,
      }],
    });
    const crashed = assessWorkflowWriteGate({
      intent: "generate_file",
      goal: "Create examples/todo-app in this codebase",
      tool: "write_file",
      hasProposal: true,
      steps: [{
        ...absentTargetStep(),
        ok: false,
        outcomeClass: "execution_error",
        outcomeKind: "tool_crash",
      }],
    });

    expect(blocked.blocked).toBe(true);
    expect(crashed.blocked).toBe(true);
  });
});

function absentTargetStep(): AgentToolStep {
  return {
    iteration: 0,
    tool: "list_files",
    input: { root: "." },
    executed: true,
    ok: false,
    outcomeClass: "observation_failure",
    outcomeKind: "no_results",
    outcomeMessage: "Workspace is empty",
    output: { root: ".", files: [] },
  };
}
