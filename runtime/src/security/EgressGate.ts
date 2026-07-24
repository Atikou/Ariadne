import type {
  ContentEgressTarget,
  ContentEnvelope,
} from "../core/ContentEnvelope.js";

export class EgressPolicyError extends Error {
  constructor(
    readonly target: ContentEgressTarget,
    readonly envelope: ContentEnvelope,
  ) {
    super(
      `egress_denied:${target}:${envelope.origin}:${envelope.dataSensitivity}`,
    );
    this.name = "EgressPolicyError";
  }
}

export function gateContentEgress(input: {
  content: string;
  envelope: ContentEnvelope;
  target: ContentEgressTarget;
}): string {
  const { envelope, target } = input;
  if (envelope.externalContent && envelope.instructionAuthority !== "data") {
    throw new EgressPolicyError(target, envelope);
  }
  if (!envelope.egressAllowed.includes(target)) {
    throw new EgressPolicyError(target, envelope);
  }
  if (envelope.dataSensitivity === "secret" && target !== "model") {
    throw new EgressPolicyError(target, envelope);
  }
  if (!envelope.externalContent) return input.content;
  return [
    `[EXTERNAL_DATA origin=${envelope.origin} authority=data]`,
    input.content,
    "[/EXTERNAL_DATA]",
  ].join("\n");
}
