import { inferDeclaredCapabilities, inferPrivacyPolicy } from "./model-capability-profile.js";
import type { ModelProfile } from "./types.js";

/** 测试夹具：为手工 ModelProfile 补齐 declaredCapabilities / privacy。 */
export function withDeclaredCapabilities(
  profile: Omit<ModelProfile, "declaredCapabilities" | "privacy"> &
    Partial<Pick<ModelProfile, "declaredCapabilities" | "privacy">>,
): ModelProfile {
  const isLocal = profile.provider === "local";
  return {
    ...profile,
    declaredCapabilities:
      profile.declaredCapabilities ??
      inferDeclaredCapabilities({
        isLocal,
        defaultLevel: profile.defaultLevel,
        supportsVision: profile.supportsVision,
        supportsTools: profile.supportsTools,
        supportsJsonMode: profile.supportsJsonMode,
        maxInputTokens: profile.maxInputTokens,
      }),
    privacy:
      profile.privacy ??
      inferPrivacyPolicy({
        isLocal,
      }),
  };
}
