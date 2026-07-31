const { randomUUID } = require("node:crypto");
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { app: electronApp, safeStorage } = require("electron");
const { parse: parseToml } = require("smol-toml");

const projectRoot = process.cwd();
const userDataRoot = path.join(process.env.APPDATA ?? "", "Ariadne");
const settingsPath = path.join(userDataRoot, "settings.toml");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-deepseek-plan-smoke-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const dataRoot = path.join(temporaryRoot, "runtime");
const electronUserData = path.join(temporaryRoot, "electron-user-data");
const resultPath = path.join(
  projectRoot,
  "artifacts",
  "electron-runtime-smoke",
  "deepseek-agent-plan-smoke.json",
);

let runtimeApp;
let facade;

mkdirSync(electronUserData, { recursive: true });
copyFileSync(path.join(userDataRoot, "Local State"), path.join(electronUserData, "Local State"));
electronApp.setPath("userData", electronUserData);
electronApp.whenReady().then(run).catch(reportFailure);

async function run() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safe_storage_unavailable");
    }

    const settings = parseToml(readFileSync(settingsPath, "utf8"));
    const deepseek = settings.providers?.deepseek;
    if (!deepseek?.enabled || !deepseek.encryptedApiKey) {
      throw new Error("deepseek_not_configured");
    }
    process.env.DEEPSEEK_API_KEY = safeStorage.decryptString(
      Buffer.from(deepseek.encryptedApiKey, "base64"),
    );

    mkdirSync(workspaceRoot, { recursive: true });
    const { createRuntimeContext } = await import(pathToFileURL(
      path.join(projectRoot, "runtime", "dist", "application", "createRuntimeContext.js"),
    ));
    const { RuntimeFacade } = await import(pathToFileURL(
      path.join(projectRoot, "runtime", "dist", "application", "RuntimeFacade.js"),
    ));
    const runtimeBuildManifest = JSON.parse(readFileSync(
      path.join(projectRoot, "runtime", "dist", "runtime-build.json"),
      "utf8",
    ));

    runtimeApp = createRuntimeContext({
      protocol: "ariadne.runtime",
      protocolVersion: "2.0",
      runtimeInstanceId: `plan-smoke-${randomUUID()}`,
      type: "bootstrap",
      appVersion: "0.1.0-smoke",
      runtimeVersion: "0.1.0",
      runtimeBuildFingerprint: runtimeBuildManifest.fingerprint,
      installRoot: path.join(projectRoot, "runtime"),
      dataRoot,
      modelRoots: [],
      modelProviders: [{
        providerId: "deepseek",
        name: "cloud-deepseek",
        protocol: "openai-compatible",
        credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
        enabled: true,
        baseUrl: deepseek.baseUrl,
        model: deepseek.model,
        inference: deepseek.inference ?? {},
      }],
      routingStrategy: "cloud-first",
      agentPermissions: {
        approvalPolicy: "request",
        proposalApproval: "manual",
        permissionPolicy: "confirmBeforeRun",
        sandboxMode: "workspace-write",
        allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
      },
      runtimePolicy: settings.runtimePolicy,
      profile: "default",
      workspaces: [{
        workspaceId: "primary",
        label: "DeepSeek plan smoke",
        rootPath: workspaceRoot,
        access: "write",
      }],
      production: false,
    });
    facade = new RuntimeFacade(runtimeApp, () => {}, "0.1.0", {
      activityDataRoot: dataRoot,
      conversationWorkspaceStateFile: path.join(dataRoot, "conversation-workspaces.json"),
      workspaces: [{
        workspaceId: "primary",
        label: "DeepSeek plan smoke",
        access: "write",
      }],
      agentPermissionPolicy: "confirmBeforeRun",
    });
    await runtimeApp.start();
    await facade.start();

    const accepted = await facade.handle({
      kind: "companion.chat.start",
      clientMessageId: `plan-user-${randomUUID()}`,
      workspaceId: "primary",
      modelId: "cloud-deepseek",
      message: [
        "Create a read-only implementation plan for a small static todo page.",
        "The plan must include concrete steps and verification criteria.",
        "Do not implement anything and do not write files.",
      ].join(" "),
      agentMode: "plan",
      resources: [],
    });
    if (
      accepted.kind !== "companion.chat.accepted"
      || accepted.executionMode !== "agent-plan"
    ) {
      throw new Error("plan_request_was_silently_downgraded");
    }

    const handoff = await waitFor(async () => {
      const handoffs = await facade.handle({ kind: "planHandoffs.list" });
      if (handoffs.kind !== "planHandoffs") return undefined;
      return handoffs.handoffs.find((candidate) => candidate.runId === accepted.runId);
    }, 180_000, "plan_handoff_not_created");
    const run = await facade.handle({ kind: "runs.get", runId: accepted.runId });
    if (
      run.kind !== "run"
      || run.run.status !== "waiting_plan_handoff"
      || handoff.plan.steps.length === 0
      || handoff.plan.completionCriteria.length === 0
      || handoff.plan.planState !== "ready_for_confirmation"
    ) {
      throw new Error("plan_contract_or_waiting_state_invalid");
    }

    writeResult({
      ok: true,
      provider: "deepseek",
      executionMode: accepted.executionMode,
      runStatus: run.run.status,
      planState: handoff.plan.planState,
      planStepCount: handoff.plan.steps.length,
      completionCriterionCount: handoff.plan.completionCriteria.length,
    });
    process.exitCode = 0;
  } catch (error) {
    await reportFailure(error);
    return;
  }
  await cleanupAndExit();
}

async function reportFailure(error) {
  writeResult({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  await cleanupAndExit();
}

function writeResult(result) {
  mkdirSync(path.dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function cleanupAndExit() {
  delete process.env.DEEPSEEK_API_KEY;
  try {
    if (facade) await facade.stop();
  } catch {}
  try {
    if (runtimeApp) await runtimeApp.shutdown();
  } catch {}
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {}
  electronApp.exit(process.exitCode ?? 0);
}

async function waitFor(probe, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(code);
}
