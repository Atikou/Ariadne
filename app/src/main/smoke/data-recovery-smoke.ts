import { app, dialog, type BrowserWindow } from 'electron';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSessionTextExport } from '../data-management/session-text-export';
import type { Result } from '@shared/contract';
import type { RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';
import type { BackupCreatedView, DataRestorePreview } from '@shared/data-management';

/** Actual packaged Main/Renderer/production Runtime cold start on a named
 * authenticated recovery fixture. Never shows/focuses the hidden window,
 * submits a new model turn, or returns private text/keys in evidence. */
export async function verifyDataRecoveryWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  const root = process.env.ARIADNE_SMOKE_USER_DATA, workspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID;
  if (!app.isPackaged || !root || !workspaceId || !isAbsolute(root)) throw new Error('data_recovery_packaged_scope_required');
  const canonical = await realpath(root), parent = dirname(canonical);
  if (dirname(parent) !== await realpath(tmpdir()) || !basename(parent).startsWith('AriadneRecoveryColdStart-')
    || basename(canonical) !== 'profile') throw new Error('data_recovery_fixture_scope_invalid');
  if (await realpath(app.getPath('sessionData')) !== canonical) throw new Error('data_recovery_session_profile_not_isolated');
  if (outputRoot !== join(parent, 'evidence')) throw new Error('data_recovery_evidence_scope_invalid');
  await mkdir(outputRoot, { recursive: true });
  if (await realpath(outputRoot) !== outputRoot) throw new Error('data_recovery_evidence_scope_invalid');
  const lifecycle = process.env.ARIADNE_SMOKE_DATA_RECOVERY_LIFECYCLE;
  if (lifecycle !== undefined && lifecycle !== 'create-backup' && lifecycle !== 'restored') throw new Error('data_recovery_lifecycle_invalid');
  // The retained synthetic file is deliberately dirty. Exercise the original
  // retain-draft quit path without opening a physical native decision dialog.
  // This fixture choice stays installed until this isolated process quits.
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args.at(-1) as Electron.MessageBoxOptions;
    if (options.title !== '处理未保存文件') throw new Error('data_recovery_unexpected_native_dialog');
    return { response: 1, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  const errors: string[] = [];
  const onConsole = (details: Electron.WebContentsConsoleMessageEventParams): void => {
    if (details.level === 'error' && errors.length < 32) errors.push('renderer_error');
  };
  window.webContents.on('console-message', onConsole);
  let phase = 'bootstrap', passed = false, diagnosticCode: string | null = null;
  const observations: Record<string, boolean | number> = {};
  try {
    if (window.webContents.isLoading()) await new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()));
    await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if ((await window.ariadne?.runtime.getStatus())?.value?.availability === 'ready'
          && window.__ariadneRendererCompositionRootV1?.services) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      } throw new Error('data_recovery_bootstrap_timeout');
    })()`);
    if (window.isVisible() || window.isFocused()) throw new Error('data_recovery_window_not_hidden');
    observations.productionPackagedStartup = true;
    phase = 'private-main-stores';
    Object.assign(observations, await window.webContents.executeJavaScript(`(async () => {
      const api = window.ariadne, drafts = await api.chatDrafts.list(), files = await api.fileDrafts.list();
      const row = drafts.find(row => row.editing.text === 'SYNTHETIC_PRIVATE_CHAT');
      if (!row || row.owner.workspaceId !== ${JSON.stringify(workspaceId)} || row.editing.attachments.length !== 1)
        throw new Error('data_recovery_chat_draft_changed');
      const image = await api.chatDrafts.readAttachment({ owner: row.owner, attachmentId: row.editing.attachments[0].attachmentId });
      const decoded = await createImageBitmap(new Blob([Uint8Array.from(atob(image.data), char=>char.charCodeAt(0))], { type: image.mediaType }));
      if (decoded.width !== 2 || decoded.height !== 2) throw new Error('data_recovery_private_image_changed'); decoded.close();
      if (!files.records.some(row => row.workspaceId === ${JSON.stringify(workspaceId)} && row.content === 'SYNTHETIC_PRIVATE_FILE'
        && row.originalContent === 'baseline' && row.pendingMutation === null)) throw new Error('data_recovery_file_draft_changed');
      if ((await api.preferences.load()).theme !== 'dark') throw new Error('data_recovery_preferences_changed');
      const retained = (await api.inputDeliveryOutbox.list()).find(row => row.commandId === 'native-unknown-input');
      if (!retained || retained.command.kind !== 'conversation.session.create') throw new Error('data_recovery_unknown_input_lost');
      return { protectedChatDraftRead: true, protectedDraftImageDecoded: true, protectedFileDraftRead: true,
        preferencesRestored: true, retainedInputRead: true };
    })()`));
    phase = 'authorized-public-history';
    const request = async (command: RuntimeCommand): Promise<RuntimeResult> => {
      const result = await window.webContents.executeJavaScript(`window.ariadne.runtime.request(${JSON.stringify(command)})`) as Result<RuntimeResult>;
      if (!result.ok) throw new Error('data_recovery_public_read_failed'); return result.value;
    };
    let userText = false, assistantText = false;
    const exported = await writeSessionTextExport({ workspaceId, sessionId: 'session-native', scope: 'public-message-text', format: 'jsonl' },
      request, async line => {
        const record = JSON.parse(line) as { content?: string };
        userText ||= record.content === 'Synthetic protected recovery input';
        assistantText ||= record.content === 'SYNTHETIC_NATIVE_PROTECTED_RESPONSE';
      });
    if (!userText || !assistantText || exported.attachmentReferences < 1) throw new Error('data_recovery_public_history_changed');
    Object.assign(observations, { originalUserTextRead: true, originalProtectedResponseProjected: true,
      messageAttachmentReferencesRead: true, publicMessages: exported.messages });
    phase = 'original-renderer-navigation';
    Object.assign(observations, await window.webContents.executeJavaScript(`(async () => {
      const services = window.__ariadneRendererCompositionRootV1.services;
      const wait = async (probe) => { const deadline = Date.now()+60000; while(Date.now()<deadline) {
        const value = probe(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,100));
      } throw new Error('data_recovery_renderer_timeout'); };
      if (!(await services.conversationNavigation.listSelectableWorkspaces()).some(row=>row.workspaceId===${JSON.stringify(workspaceId)}))
        throw new Error('data_recovery_workspace_not_selectable');
      await services.conversationNavigation.selectWorkspace(${JSON.stringify(workspaceId)});
      await services.sessions.select('session-native');
      const metadata = await wait(()=>services.messages.view.getSnapshot().messageWindow);
      for (const message of services.messages.view.getSnapshot().messages) await services.messages.loadBody(message.messageId, 'session-native', metadata.windowDigest);
      await wait(()=>document.querySelector('.chat-panel')?.textContent.includes('Synthetic protected recovery input')
        && document.querySelector('.chat-panel')?.textContent.includes('SYNTHETIC_NATIVE_PROTECTED_RESPONSE'));
      await wait(()=>document.querySelector('.message-image-attachment')?.textContent.includes('2 × 2'));
      await services.runs.openDetail('run-native');
      const run = await wait(()=>services.runs.view.getSnapshot().runs.find(row=>row.runId==='run-native'&&row.status==='completed'));
      return { originalRendererHistoryRead: true, originalRendererAttachmentMetadataRead: true, terminalRunVersion: run.aggregateVersion };
    })()`));
    if (window.isVisible() || window.isFocused() || errors.length) throw new Error('data_recovery_hidden_acceptance_failed');
    if (lifecycle === 'create-backup') {
      phase = 'original-data-management-ipc';
      const exportPath = join(parent, 'authorized-session.jsonl');
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.SaveDialogOptions;
        if (options.title !== '导出会话正文（不含图像文件或工具详情）') throw new Error('data_recovery_unexpected_native_dialog');
        return { canceled: false, filePath: exportPath };
      }) as typeof dialog.showSaveDialog;
      const metadata = await window.webContents.executeJavaScript(`(async()=>{
        const api=window.ariadne.dataManagement, usage=await api.measureUsage();
        const cleanup=await api.inspectCleanup();
        if(cleanup.referencedObjects!==1||cleanup.orphanObjects!==0||cleanup.unpublishedObjects!==0)
          throw new Error('data_recovery_owned_cleanup_inventory_changed');
        await api.discardCleanup({ticket:cleanup.ticket});
        const exported=await api.exportSession({workspaceId:${JSON.stringify(workspaceId)},sessionId:'session-native',scope:'public-message-text',format:'jsonl'});
        if(!exported||exported.messages!==2||exported.attachmentReferences!==1||usage.totalBytes<=0||usage.databases.files<7)
          throw new Error('data_recovery_data_ipc_metadata_invalid');
        return {originalUsageMeasured:true,originalProtectedCleanupPreviewDiscarded:true,originalSessionExportWritten:true,
          exportedMessages:exported.messages,exportedAttachmentReferences:exported.attachmentReferences};})()`);
      const exportText = await readFile(exportPath, 'utf8');
      if (!exportText.includes('Synthetic protected recovery input') || !exportText.includes('SYNTHETIC_NATIVE_PROTECTED_RESPONSE')
        || exportText.includes('SYNTHETIC_PRIVATE_CHAT') || exportText.includes('SYNTHETIC_PRIVATE_FILE') || exportText.includes('SYNTHETIC_NATIVE_PRIVATE_KEY'))
        throw new Error('data_recovery_export_scope_changed');
      phase = 'original-application-backup';
      const destination = join(parent, 'backups'); await mkdir(destination);
      let restoreDirectory: string | undefined;
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.OpenDialogOptions;
        if (options.title === '选择备份保存位置') return { canceled: false, filePaths: [destination] };
        if (options.title === '选择 Ariadne 备份目录' && restoreDirectory) return { canceled: false, filePaths: [restoreDirectory] };
        throw new Error('data_recovery_unexpected_native_dialog');
      }) as typeof dialog.showOpenDialog;
      const backup = await window.webContents.executeJavaScript('window.ariadne.dataManagement.createBackup()') as BackupCreatedView | null;
      if (!backup) throw new Error('data_recovery_application_backup_missing');
      restoreDirectory = await realpath(join(destination, 'Ariadne-backup-' + backup.backupId));
      if (dirname(restoreDirectory) !== await realpath(destination)) throw new Error('data_recovery_backup_destination_changed');
      phase = 'isolated-preference-mutation';
      await window.webContents.executeJavaScript(`(async()=>{const api=window.ariadne;await api.preferences.update({...await api.preferences.load(),theme:'light'});
        if((await api.preferences.load()).theme!=='light')throw new Error('data_recovery_fixture_mutation_failed');})()`);
      phase = 'original-application-restore-inspect';
      const preview = await window.webContents.executeJavaScript('window.ariadne.dataManagement.inspectRestore()') as DataRestorePreview | null;
      if (!preview || preview.backupId !== backup.backupId) throw new Error('data_recovery_application_restore_preview_missing');
      await writeFile(join(outputRoot, 'application-restore-checkpoint.json'), JSON.stringify({ firstMainPid: process.pid,
        backup, terminalRunVersion: observations.terminalRunVersion, originalDataManagement: metadata, originalApplicationBackup: true,
        originalRendererDraftBarrier: true, isolatedPreferenceChangedAfterBackup: true, originalApplicationRestoreInspect: true,
        nativeDialogSelection: 'isolated fixture', physicalInteraction: false }, null, 2));
      process.env.ARIADNE_SMOKE_DATA_RECOVERY_LIFECYCLE = 'restored';
      phase = 'original-application-restore-commit';
      // Original commit closes all owners, arms its detached helper and exits
      // this Main. That helper inherits only this owned fixture's next phase.
      await window.webContents.executeJavaScript(`window.ariadne.dataManagement.commitRestore({ticket:${JSON.stringify(preview.ticket)}})`);
      throw new Error('data_recovery_commit_did_not_exit');
    }
    if (lifecycle === 'restored') {
      const checkpoint = JSON.parse(await readFile(join(outputRoot, 'application-restore-checkpoint.json'), 'utf8'));
      if (checkpoint.firstMainPid === process.pid || checkpoint.terminalRunVersion !== observations.terminalRunVersion)
        throw new Error('data_recovery_terminal_run_changed');
      observations.originalApplicationRestoreCommitRelaunched = true;
      observations.preferenceMutationReplacedByBackup = true;
      observations.terminalRunVersionUnchanged = true;
    }
    observations.hiddenWindowThroughout = true; passed = true;
  } catch (error) {
    diagnosticCode = error instanceof Error ? /\bdata_recovery_[a-z_]+\b/u.exec(error.message)?.[0] ?? 'smoke_driver_failed' : 'smoke_driver_failed';
  }
  finally { window.webContents.removeListener('console-message', onConsole); }
  await writeFile(join(outputRoot, 'data-recovery-cold-start.json'), JSON.stringify({ passed, phase, mainPid: process.pid,
    observations, diagnosticCode, rendererErrors: errors.length, originalPackagedApplication: true, submittedNewModelTurn: false,
    unsavedFileQuitChoice: 'isolated fixture retain through original owner',
    physicalInteraction: false, completedAt: new Date().toISOString() }, null, 2));
  if (passed && (lifecycle === 'restored' || process.env.ARIADNE_SMOKE_DATA_RECOVERY_OBSERVE_EXIT === '1')) {
    // Test driver opens this exact live Main's Windows process handle before
    // acknowledging. Normal quit then supplies actual clean-exit evidence.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { if (await readFile(join(outputRoot, 'observe-relaunched-main.ack'), 'utf8') === String(process.pid)) return true; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('data_recovery_relaunched_observer_missing');
  }
  return passed;
}
