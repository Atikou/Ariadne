export interface ParallelVoteCandidate {
  modelId: string;
  answer: string;
  callLogId: string;
}

export interface ParallelVoteResult {
  winnerIndex: number;
  winnerModelId: string;
  reason?: string;
  candidates: ParallelVoteCandidate[];
}
