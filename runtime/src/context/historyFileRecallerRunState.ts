interface RunStateLocationSlice {
  visitedFiles?: string[];
  candidateFiles?: string[];
  primaryFiles?: string[];
}

/** 解析 run_states.state_json 中的文件线索。 */
export function deserializeRunStateFromJson(json: string): {
  readFiles: string[];
  location?: RunStateLocationSlice;
} {
  const parsed = JSON.parse(json) as {
    readFiles?: unknown;
    location?: RunStateLocationSlice;
  };
  return {
    readFiles: Array.isArray(parsed.readFiles)
      ? parsed.readFiles.filter((item): item is string => typeof item === "string")
      : [],
    location: parsed.location,
  };
}
