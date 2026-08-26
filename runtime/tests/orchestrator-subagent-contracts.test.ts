import { describe, expect, expectTypeOf, it } from "vitest";

import type { OrchestratorResult } from "../src/model-orchestrator/types.js";
import type { ParallelVoteResult } from "../src/model-orchestrator/pipelines/parallel-vote-pipeline.js";
import type { SubAgentWriteConflict } from "../src/subagent/types.js";
import { normalizeRelPath } from "../src/subagent/writeConflictMerge.js";
import {
  parseWriteFilePickHints,
  type WriteFilePickStrategy,
} from "../src/subagent/writeFileVersionPick.js";

describe("orchestrator and subagent compatibility contracts", () => {
  it("keeps the parallel vote result available through its established pipeline export", () => {
    expectTypeOf<ParallelVoteResult>().toEqualTypeOf<
      NonNullable<OrchestratorResult["voteResult"]>
    >();
  });

  it("keeps write conflict values normalized through the established exports", () => {
    const strategy: WriteFilePickStrategy = "arbitration";
    const conflict: SubAgentWriteConflict = {
      path: ".\\src\\result.ts",
      taskIds: ["task-1", "task-2"],
      changeIds: ["change-1", "change-2"],
      reason: "same file",
    };

    expect(strategy).toBe("arbitration");
    expect(normalizeRelPath(conflict.path)).toBe("src/result.ts");
    expect(parseWriteFilePickHints("WRITE_PICK: path=.\\src\\result.ts taskId=task-2")).toEqual([
      {
        path: "src/result.ts",
        changeId: undefined,
        taskId: "task-2",
        manual: false,
      },
    ]);
  });
});
