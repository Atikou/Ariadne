const { randomUUID } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { app: electronApp, safeStorage } = require("electron");
const { parse: parseToml } = require("smol-toml");

const projectRoot = process.cwd();
const userDataRoot = path.join(process.env.APPDATA ?? "", "Ariadne");
const settingsPath = path.join(userDataRoot, "settings.toml");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-deepseek-agent-smoke-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const dataRoot = path.join(temporaryRoot, "runtime");
const electronUserData = path.join(temporaryRoot, "electron-user-data");
const proofFile = path.join(workspaceRoot, "agent-e2e-proof.txt");
const proofContent = "ARIADNE_DEEPSEEK_PERMISSION_RESUME_OK";

let runtimeApp;
let facade;

mkdirSync(electronUserData, { recursive: true });
copyFileSync(path.join(userDataRoot, "Local State"), path.join(electronUserData, "Local State"));
electronApp.setPath("userData", electronUserData);
electronApp.whenReady().then(run).catch(fail);

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

    runtimeApp = createRuntimeContext({
      protocol: "ariadne.runtime",
      protocolVersion: "2.0",
      runtimeInstanceId: `smoke-${randomUUID()}`,
      type: "bootstrap",
      appVersion: "0.1.0-smoke",
      runtimeVersion: "0.1.0",
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
        label: "DeepSeek Agent smoke",
        rootPath: workspaceRoot,
        access: "write",
      }],
      production: false,
    });
    const events = [];
    facade = new RuntimeFacade(runtimeApp, (event) => events.push(event), "0.1.0", {
      conversationWorkspaceStateFile: path.join(dataRoot, "conversation-workspaces.json"),
      workspaces: [{
        workspaceId: "primary",
        label: "DeepSeek Agent smoke",
        access: "write",
      }],
      proposalApproval: "manual",
      allowedPermissions: ["read", "write", "shell", "network", "dangerous"],
    });
    await runtimeApp.start();
    await facade.start();

    const proposal = runtimeApp.agentHandoffCoordinator.submitProposal({
      sourceTurnId: `smoke-turn-${randomUUID()}`,
      reason: "Verify the real DeepSeek Agent permission and resume state machine.",
      originalRequest: [
        `Create the file ${proofFile}.`,
        `Its entire content must be exactly ${proofContent}.`,
        "Use an available file-writing tool, then read the file back before reporting completion.",
      ].join(" "),
      interpretedTask: "Create and verify one exact proof file in the active workspace.",
      requestedCapabilities: ["file-read", "file-write"],
      requestedScope: [workspaceRoot],
      risk: "write",
      workspaceKey: "primary",
      modelBinding: {
        selectionMode: "manual",
        clientName: "cloud-deepseek",
        modelName: deepseek.model,
        protocolVersion: "ariadne.agent-proposal.v1",
      },
    });

    await facade.handle({
      kind: "agent.proposals.respond",
      proposalId: proposal.id,
      decision: "approve_once",
      allowedCapabilities: ["file-read", "file-write"],
      workspaceId: "primary",
    });

    const pending = await waitFor(async () => {
      const listed = await facade.handle({ kind: "permissions.list" });
      if (listed.kind !== "permissions") return undefined;
      return listed.requests[0];
    }, 120_000, "permission_popup_not_created");

    if (existsSync(proofFile)) throw new Error("write_executed_before_permission");
    const beforeApproval = runtimeApp.runs.get(pending.runId);
    if (beforeApproval?.status !== "waiting_confirmation") {
      throw new Error(`unexpected_preapproval_status:${beforeApproval?.status ?? "missing"}`);
    }

    await facade.handle({
      kind: "permissions.respond",
      requestId: pending.requestId,
      approvalVersion: pending.approvalVersion,
      decision: "allow_once",
      approvedItemIds: pending.permissionItems.map((item) => item.itemId),
    });

    const completed = await waitFor(async () => {
      const current = runtimeApp.runs.get(pending.runId);
      if (!current) return undefined;
      if (current.status === "recovery_required") {
        throw new Error(`resume_entered_recovery:${current.waitReason?.code ?? "unknown"}`);
      }
      if (current.status === "failed" || current.status === "cancelled") {
        throw new Error(`run_terminal_failure:${current.status}:${current.error ?? "unknown"}`);
      }
      return current.status === "completed" ? current : undefined;
    }, 180_000, "permission_resume_did_not_complete");

    const actual = readFileSync(proofFile, "utf8");
    if (actual !== proofContent) throw new Error("proof_file_content_mismatch");
    const remainingPermissions = await facade.handle({ kind: "permissions.list" });
    if (remainingPermissions.kind !== "permissions" || remainingPermissions.requests.length !== 0) {
      throw new Error("permission_request_not_settled");
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "deepseek",
      model: deepseek.model,
      permissionObserved: true,
      preApprovalStatus: beforeApproval.status,
      postApprovalStatus: completed.status,
      proofVerified: true,
      recoveryEvents: events.filter(
        (event) => event.event.kind === "run.changed" && event.event.run.status === "interrupted",
      ).length,
    })}\n`);
  } catch (error) {
    await reportFailure(error);
  } finally {
    await cleanup();
  }
}

async function fail(error) {
  await reportFailure(error);
  await cleanup();
}

async function reportFailure(error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

async function cleanup() {
  delete process.env.DEEPSEEK_API_KEY;
  try {
    if (facade) await facade.stop();
  } catch {}
  try {
    if (runtimeApp) await runtimeApp.shutdown();
  } catch {}
  electronApp.once("quit", () => {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } catch {}
  });
  electronApp.quit();
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
