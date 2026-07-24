export function buildParallelVoteJudgeMessages(
  userInput: string,
  candidates: Array<{ index: number; modelId: string; answer: string }>,
): Array<{ role: "system" | "user"; content: string }> {
  const payload = JSON.stringify(
    {
      userQuestion: userInput,
      candidates: candidates.map((c) => ({
        index: c.index,
        modelId: c.modelId,
        answer: c.answer.slice(0, 4000),
      })),
    },
    null,
    2,
  );
  return [
    {
      role: "system",
      content: [
        "你是模型回答裁决器。根据用户问题，从多个候选回答中选出最佳的一条。",
        "只输出 JSON：",
        '{"winnerIndex":0,"reason":"简短理由"}',
        "winnerIndex 为 candidates 中的 index；若均不可用选相对最好的一条。",
      ].join("\n"),
    },
    { role: "user", content: payload },
  ];
}
