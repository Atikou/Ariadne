import { app, safeStorage } from 'electron';
import { realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { ElectronSafeStorageCipher } from '../../src/main/persistence/secret-cipher';
import { AgentPersistenceKeyRingStore } from '../../src/main/persistence/agent-persistence-keyring';
import { AgentSettingsRepository } from '../../src/main/persistence/agent-settings-repository';
import { StateRepository } from '../../src/main/persistence/state-repository';
import { ChatDraftRepository } from '../../src/main/persistence/chat-draft-repository';
import { FileDraftRepository } from '../../src/main/persistence/file-draft-repository';
import { InputDeliveryOutbox } from '../../src/main/persistence/input-delivery-outbox';
import { McpOAuthCredentialVault } from '../../src/main/persistence/mcp-oauth-credential-vault';
import { TerminalSessionJournal } from '../../src/main/persistence/terminal-session-journal';
import { FileDecisionNotificationReceipts } from '../../src/main/persistence/decision-notification-receipts';
import { TaskNotificationReceipts } from '../../src/main/persistence/task-notification-receipts';
import { RuntimeSupervisor, RuntimeRequestError } from '../../src/main/runtime/runtime-supervisor';
import { createDesktopRuntimeConfiguration } from '../../src/main/runtime/runtime-configuration';
import { MainMaintenanceGate } from '../../src/main/data-management/main-maintenance-gate';
import { DataBackupService } from '../../src/main/data-management/data-backup-service';
import { WindowsBackupKeyProtector } from '../../src/main/runtime/windows-backup-key-protector';

// Test-only native Main source. Commands below are explicit synthetic inputs
// through original owners/Core, not a Provider or actual-model quality claim.
const [source, runtimeEntry, nodeExecutable, destination, staging, coreEntry] = process.argv.slice(2);
if (!process.send || !source || !runtimeEntry || !nodeExecutable || !destination || !staging
  || !coreEntry || ![source, runtimeEntry, nodeExecutable, destination, staging, coreEntry].every(isAbsolute)
  || !basename(source).startsWith('AriadneDomainHealth-Protected-') || lstatSync(source).isSymbolicLink()
  || realpathSync.native(source) !== source) throw new Error('protected_native_fixture_scope_invalid');
app.setPath('userData', source); app.setPath('sessionData', source);
let supervisor: RuntimeSupervisor | undefined, notifications: TaskNotificationReceipts | undefined;
let phase = 'native-profile';
void app.whenReady().then(async () => {
  // The fixture owns a fresh profile and explicitly initializes Chromium's
  // key before exercising the production durable-key barrier.
  safeStorage.encryptString('SYNTHETIC_PROFILE_INITIALIZATION');
  const cipher = new ElectronSafeStorageCipher(); await cipher.initialize();
  phase = 'main-owners';
  const gate = new MainMaintenanceGate();
  const keyStore = new AgentPersistenceKeyRingStore(join(source, 'agent-persistence-keyring.json'), cipher, undefined, undefined, undefined, gate);
  const settings = new AgentSettingsRepository(join(source, 'settings.toml'), cipher, undefined, gate);
  const state = new StateRepository(join(source, 'state.json'), gate);
  const chat = new ChatDraftRepository(join(source, 'chat-drafts.json'), cipher, gate);
  const files = new FileDraftRepository(join(source, 'file-drafts.json'), cipher, gate);
  const outbox = new InputDeliveryOutbox(join(source, 'agent-input-delivery-outbox.json'), cipher, undefined, gate);
  const vault = new McpOAuthCredentialVault(join(source, 'mcp-oauth-vault.json'), cipher, gate);
  const terminal = new TerminalSessionJournal(join(source, 'terminal-sessions.json'), undefined, gate);
  const decisions = new FileDecisionNotificationReceipts(join(source, 'decision-notifications.json'), undefined, gate);
  notifications = new TaskNotificationReceipts(join(source, 'notification-delivery.db'), undefined, gate);
  await Promise.all([keyStore.initialize(), settings.initialize(), state.initialize(), chat.initialize(), files.initialize(),
    outbox.initialize(), vault.initialize(), terminal.initialize(), decisions.initialize(), notifications.initialize()]);
  const workspaceRoot = join(dirname(destination), 'workspace'); await mkdir(workspaceRoot);
  const workspaceId = (await settings.addWorkspaceRoot(workspaceRoot)).workspace.workspaceId;
  const changed = await settings.mutate({ expectedRevision: settings.getView().revision,
    operations: [{ kind: 'provider.update', providerId: 'openai', patch: { apiKey: 'SYNTHETIC_NATIVE_PRIVATE_KEY', enabled: false } }] });
  if (!changed.ok) throw new Error('protected_native_fixture_settings_failed');
  await state.savePreferences({ ...state.getPreferences(), theme: 'dark' });
  await vault.saveTokens('mcp:native-fixture', { access_token: 'SYNTHETIC_NATIVE_TOKEN', token_type: 'Bearer' });
  const attachmentId = randomUUID();
  const draftImage = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#77bb88' } }).png().toBuffer();
  await chat.write({ owner: { workspaceId, target: { kind: 'new', draftId: randomUUID() } }, expectedStorageRevision: null,
    editing: { revision: 1, generation: randomUUID(), imageEpoch: 0, updatedAt: new Date().toISOString(), text: 'SYNTHETIC_PRIVATE_CHAT',
      attachments: [{ attachmentId, bytes: draftImage.length, mediaType: 'image/png' }] }, submissions: [],
    uploads: [{ attachmentId, attachment: { mediaType: 'image/png', data: draftImage.toString('base64') } }] });
  await files.replace({ expectedRevision: 0, records: [{ draftId: randomUUID(), workspaceId, path: 'fixture.txt', revision: 1,
    updatedAt: new Date().toISOString(), content: 'SYNTHETIC_PRIVATE_FILE', originalContent: 'baseline', version: 'workspace-file-v1:' + 'a'.repeat(64),
    writable: true, exists: true, pendingMutation: null }] });
  const draftSubmissionId = randomUUID();
  await outbox.stage({ commandId: 'native-unknown-input', draftSubmissionId, command: { kind: 'conversation.session.create',
    contractVersion: '5.0', workspaceId, sessionId: 'session-unknown', title: 'Synthetic retained input' } });
  // Cold-start acceptance must remain hidden and cannot create Windows toasts.
  // Both persisted preferences are exercised through the original owner.
  notifications.configure({ completed: false, failed: false });
  const configuration = createDesktopRuntimeConfiguration({ appPath: join(dirname(dirname(dirname(runtimeEntry))), '..', 'app'),
    userDataPath: source, resourcesPath: process.resourcesPath, appVersion: 'native-fixture', packaged: false,
    executablePath: process.execPath, agentSettings: settings.getRuntimeSettings(), environment: {
      ...process.env, ARIADNE_RUNTIME_ENTRY: runtimeEntry, ARIADNE_RUNTIME_NODE_EXECUTABLE: nodeExecutable } });
  supervisor = new RuntimeSupervisor({ ...configuration, production: true, capabilityHandler: async request => {
    if (request.capability !== 'agent_persistence') throw new Error('protected_native_fixture_capability_denied');
    return { ...await keyStore.loadForRuntime(), runtimeInstanceId: request.runtimeInstanceId };
  } });
  phase = 'production-runtime';
  await supervisor.start();
  phase = 'original-runtime-offline';
  await supervisor.withOfflineMaintenance(async () => {
    phase = 'original-core-private-node';
    const keyRing = { ...await keyStore.loadForRuntime(), runtimeInstanceId: randomUUID() };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(nodeExecutable, [coreEntry], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      let response: { ok: boolean; phase?: string } | null = null;
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout?.resume(); child.stderr?.resume();
      child.on('error', reject); child.on('message', value => { response = value as typeof response; });
      child.on('close', code => { clearTimeout(timer); if (code !== 0 || !response?.ok) {
        phase = response?.phase ?? 'original-core-process'; reject(new Error('protected_native_core_failed')); return; }
        phase = 'original-runtime-resume'; resolve(); });
      child.send({ dataRoot: join(source, 'runtime'), keyRing, workspaceId });
    });
  });
  phase = 'controlled-backup';
  const backup = new DataBackupService({ userData: source, sessionData: source, stagingParent: staging, appVersion: 'native-fixture', gate,
    runtime: supervisor, runtimeWorker: { entry: join(dirname(runtimeEntry), 'storage-maintenance-process.js'), executablePath: nodeExecutable, dataRoot: join(source, 'runtime') },
    taskNotificationReceipts: notifications, protector: new WindowsBackupKeyProtector(),
    // This source has no Renderer or native notification consumer. Production
    // Application hooks have a separate interactive acceptance requirement.
    prepareRendererDrafts: async () => {}, resumeRendererDrafts: async () => {}, pauseNotifications: async () => {}, resumeNotifications: async () => {},
    beforeFreeze: async () => {}, stopMainRuntimeProducers: async () => {}, flushMainOwners: async () => {
      await Promise.all([settings.flush(), state.flush(), chat.flush(), files.flush(), outbox.flush(), vault.flush(), terminal.flush(), decisions.flush()]);
    } });
  const published = await backup.create(destination);
  phase = 'source-shutdown';
  await supervisor.stop('app_quit'); notifications.close();
  process.send!({ ok: true, published, productionRuntime: true, syntheticCoreCommands: true, rendererHooks: 'fixture-no-window',
    fixtureWorkspace: { workspaceId, rootPath: workspaceRoot } }, error => app.exit(error ? 1 : 0));
}).catch(async (error: unknown) => { try { await supervisor?.stop('app_quit'); notifications?.close(); } finally {
  process.send?.({ ok: false, code: 'protected_native_source_failed', phase,
    diagnosticCode: error instanceof RuntimeRequestError ? error.code : 'fixture_failure' }, () => app.exit(1));
} });
