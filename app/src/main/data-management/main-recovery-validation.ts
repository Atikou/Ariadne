import { open, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { StateRepository } from '../persistence/state-repository';
import { AgentSettingsRepository } from '../persistence/agent-settings-repository';
import { ChatDraftRepository } from '../persistence/chat-draft-repository';
import { FileDraftRepository } from '../persistence/file-draft-repository';
import { InputDeliveryOutbox } from '../persistence/input-delivery-outbox';
import { FileDecisionNotificationReceipts } from '../persistence/decision-notification-receipts';
import { McpOAuthCredentialVault } from '../persistence/mcp-oauth-credential-vault';
import { TerminalSessionJournal } from '../persistence/terminal-session-journal';
import { AgentPersistenceKeyRingStore, type RuntimeAgentPersistenceKeyRing } from '../persistence/agent-persistence-keyring';
import { validateTaskNotificationBackup } from '../persistence/task-notification-receipts';
import type { SecretCipher } from '../persistence/secret-cipher';

/** No owner initializes here: initialization may migrate, repair or change
 * recovery state. The original current readers validate authenticated copies. */
export async function validateMainRecoveryFiles(userData: string, cipher: SecretCipher): Promise<{
  checkedPrivateFiles: number; keyRing: RuntimeAgentPersistenceKeyRing
}> {
  const owners = [
    ['state.json', new StateRepository(join(userData, 'state.json')), 4 * 1024 * 1024],
    ['settings.toml', new AgentSettingsRepository(join(userData, 'settings.toml'), cipher), 16 * 1024 * 1024],
    ['chat-drafts.json', new ChatDraftRepository(join(userData, 'chat-drafts.json'), cipher), 64 * 1024 * 1024],
    ['file-drafts.json', new FileDraftRepository(join(userData, 'file-drafts.json'), cipher), 32 * 1024 * 1024],
    ['agent-input-delivery-outbox.json', new InputDeliveryOutbox(join(userData, 'agent-input-delivery-outbox.json'), cipher), 128 * 1024 * 1024],
    ['decision-notifications.json', new FileDecisionNotificationReceipts(join(userData, 'decision-notifications.json')), 2 * 1024 * 1024],
    ['mcp-oauth-vault.json', new McpOAuthCredentialVault(join(userData, 'mcp-oauth-vault.json'), cipher), 128 * 1024 * 1024],
    ['terminal-sessions.json', new TerminalSessionJournal(join(userData, 'terminal-sessions.json')), 16 * 1024 * 1024]
  ] as const;
  let checkedPrivateFiles = 0;
  for (const [file, owner, maximum] of owners) {
    const path = join(userData, file);
    if (!await existsExactFile(path)) continue;
    owner.validateBackup(await readBoundedPrivateFile(path, maximum)); checkedPrivateFiles++;
  }
  const keyFile = join(userData, 'agent-persistence-keyring.json');
  if (!await existsExactFile(keyFile)) throw new Error('restore_validation_keyring_missing');
  await readBoundedPrivateFile(keyFile, 512 * 1024);
  // The original keyring does not initialize/install/rotate when loading an
  // existing recovery keyring. The isolated caller first bounds its raw file.
  const keyRing = await new AgentPersistenceKeyRingStore(keyFile, cipher).loadForRuntime(); checkedPrivateFiles++;
  const notifications = join(userData, 'notification-delivery.db');
  if (await existsExactFile(notifications)) { validateTaskNotificationBackup(notifications); checkedPrivateFiles++; }
  return { checkedPrivateFiles, keyRing };
}

export async function readBoundedPrivateFile(path: string, maximum: number): Promise<string> {
  if (!await existsExactFile(path)) throw new Error('restore_validation_file_missing');
  const file = await open(path, 'r');
  try {
    const before = await file.stat(); if (before.size > maximum) throw new Error('restore_validation_file_too_large');
    const bytes = Buffer.alloc(before.size), extra = Buffer.alloc(1); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, Math.min(128 * 1024, bytes.length - offset), offset);
      if (!result.bytesRead) throw new Error('restore_validation_file_changed'); offset += result.bytesRead; }
    if ((await file.read(extra, 0, 1, offset)).bytesRead) throw new Error('restore_validation_file_changed');
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev)
      throw new Error('restore_validation_file_changed');
    return bytes.toString('utf8');
  } finally { await file.close(); }
}
async function existsExactFile(path: string): Promise<boolean> {
  try { const value = await lstat(path); if (!value.isFile() || value.isSymbolicLink() || await realpath(path) !== path)
    throw new Error('restore_validation_file_alias'); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
