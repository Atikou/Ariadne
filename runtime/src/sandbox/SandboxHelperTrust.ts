import { createHash, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

export const SandboxHelperDistributionManifestSchema = z
  .object({
    schema: z.literal("ariadne_windows_sandbox_distribution"),
    version: z.literal(1),
    helperFile: z.literal("Ariadne.WindowsSandbox.exe"),
    sha256: sha256Hex,
    trust: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("development_unsigned") }).strict(),
      z
        .object({
          kind: z.literal("authenticode_publisher"),
          publisherCertificateSha256: sha256Hex,
        })
        .strict(),
    ]),
  })
  .strict();

export type SandboxHelperTrustMode = "development" | "trusted_distribution";
export type SandboxHelperTrustFailure =
  | "helper_missing"
  | "manifest_missing"
  | "path_outside_application"
  | "path_indirection"
  | "hardlink_rejected"
  | "manifest_oversized"
  | "manifest_invalid"
  | "publisher_untrusted"
  | "content_mismatch";

export type SandboxHelperTrustResult =
  | { trusted: true }
  | { trusted: false; reason: SandboxHelperTrustFailure };

const MANIFEST_FILE = "Ariadne.WindowsSandbox.manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024;

export function verifySandboxHelperTrust(input: {
  helperPath: string;
  mode: SandboxHelperTrustMode;
  applicationRoot?: string;
}): SandboxHelperTrustResult {
  if (!existsSync(input.helperPath)) {
    return { trusted: false, reason: "helper_missing" };
  }
  if (input.mode === "development") return { trusted: true };
  if (!input.applicationRoot) {
    return { trusted: false, reason: "path_outside_application" };
  }

  const manifestPath = path.join(path.dirname(input.helperPath), MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { trusted: false, reason: "manifest_missing" };
  }
  try {
    if (
      lstatSync(input.helperPath).isSymbolicLink() ||
      lstatSync(manifestPath).isSymbolicLink()
    ) {
      return { trusted: false, reason: "path_indirection" };
    }
    const helperIdentity = realpathSync.native(input.helperPath);
    const manifestIdentity = realpathSync.native(manifestPath);
    const applicationIdentity = realpathSync.native(input.applicationRoot);
    if (
      !isStrictDescendant(applicationIdentity, helperIdentity) ||
      !isStrictDescendant(applicationIdentity, manifestIdentity) ||
      path.dirname(helperIdentity) !== path.dirname(manifestIdentity)
    ) {
      return { trusted: false, reason: "path_outside_application" };
    }
    if (statSync(helperIdentity).nlink !== 1 || statSync(manifestIdentity).nlink !== 1) {
      return { trusted: false, reason: "hardlink_rejected" };
    }
    if (statSync(manifestIdentity).size > MAX_MANIFEST_BYTES) {
      return { trusted: false, reason: "manifest_oversized" };
    }

    const parsed = SandboxHelperDistributionManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestIdentity, "utf8")) as unknown,
    );
    if (!parsed.success) return { trusted: false, reason: "manifest_invalid" };
    if (parsed.data.trust.kind !== "authenticode_publisher") {
      return { trusted: false, reason: "publisher_untrusted" };
    }
    const actual = createHash("sha256")
      .update(readFileSync(helperIdentity))
      .digest();
    const expected = Buffer.from(parsed.data.sha256, "hex");
    if (!timingSafeEqual(actual, expected)) {
      return { trusted: false, reason: "content_mismatch" };
    }
    return { trusted: true };
  } catch {
    return { trusted: false, reason: "manifest_invalid" };
  }
}

function isStrictDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}
