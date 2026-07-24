/** 单次文件考察记录（locate / 续跑去重）。 */
export interface ExplorationStepRecord {
  path: string;
  duplicate: boolean;
  newInformation: boolean;
  contributesToGoal: boolean;
  informationGain: number;
}

/** 探索进度汇总，供工具输出与 executionMeta 复用。 */
export interface ExplorationProgressSnapshot {
  steps: ExplorationStepRecord[];
  duplicateCount: number;
  newInformationCount: number;
  contributesCount: number;
  informationGain: number;
  lowYieldLoop: boolean;
}

export interface RecordExplorationInput {
  path: string;
  contentRead: boolean;
  scoreDelta: number;
  skippedDuplicate?: boolean;
}

/** 跟踪定位探索中的重复访问、信息增益与低收益循环。 */
export class ExplorationProgressTracker {
  private readonly priorVisited: Set<string>;
  private readonly sessionVisited = new Set<string>();
  private readonly steps: ExplorationStepRecord[] = [];

  constructor(priorVisited?: Iterable<string>) {
    this.priorVisited = new Set(priorVisited ?? []);
  }

  record(input: RecordExplorationInput): ExplorationStepRecord {
    const duplicate =
      input.skippedDuplicate === true ||
      this.priorVisited.has(input.path) ||
      (input.contentRead && this.sessionVisited.has(input.path));

    const newInformation = !duplicate && input.scoreDelta > 0;
    const informationGain = duplicate ? 0 : Math.min(1, Number(input.scoreDelta.toFixed(3)));

    const step: ExplorationStepRecord = {
      path: input.path,
      duplicate,
      newInformation,
      contributesToGoal: false,
      informationGain,
    };
    this.steps.push(step);
    if (input.contentRead && !duplicate) {
      this.sessionVisited.add(input.path);
    }
    return step;
  }

  /** 将已入选 primary/candidate 的路径标记为对目标有贡献。 */
  markContributors(paths: Iterable<string>): void {
    const set = new Set(paths);
    for (const step of this.steps) {
      if (set.has(step.path)) {
        step.contributesToGoal = true;
      }
    }
  }

  snapshot(maxSteps = 30): ExplorationProgressSnapshot {
    const duplicateCount = this.steps.filter((s) => s.duplicate).length;
    const newInformationCount = this.steps.filter((s) => s.newInformation).length;
    const contributesCount = this.steps.filter((s) => s.contributesToGoal).length;
    const gainSteps = this.steps.filter((s) => !s.duplicate);
    const informationGain = gainSteps.length
      ? gainSteps.reduce((sum, s) => sum + s.informationGain, 0) / gainSteps.length
      : 0;
    const lowYieldLoop =
      this.steps.length >= 3 &&
      duplicateCount >= newInformationCount &&
      informationGain < 0.15;

    return {
      steps: this.steps.slice(0, maxSteps),
      duplicateCount,
      newInformationCount,
      contributesCount,
      informationGain: Number(informationGain.toFixed(3)),
      lowYieldLoop,
    };
  }
}
