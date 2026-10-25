import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type RuntimeResult, type RuntimeCommand } from '@ariadne/protocol/public';
import type { InputDeliveryOutboxRecord, InputDeliveryOutboxStageRequest } from '../src/shared/contract';
import { ConversationDeliveryError, ConversationInputDeliveryController } from '../src/renderer/src/core/runtime/features/conversation-input-delivery-controller';
import { PublicResultError } from '../src/renderer/src/core/runtime/public-result';
import type { DraftDeliveryBinding } from '../src/renderer/src/core/runtime/features/input-delivery-binding';
const submissionId = '10000000-0000-4000-8000-000000000001';
function requests(): InputDeliveryOutboxStageRequest[] { return [
  { commandId: 'create-original', draftSubmissionId: submissionId, command: { kind: 'conversation.session.create', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    sessionId: 'session-a', workspaceId: 'workspace-a', title: 'A' } },
  { commandId: 'accept-original', draftSubmissionId: submissionId, command: { kind: 'conversation.message.accept', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    sessionId: 'session-a', workspaceId: 'workspace-a', expectedSessionVersion: 1, messageId: submissionId, content: 'A', execution: { mode: 'agent' } } }
]; }
function fixture() {
  const records = new Map<string, InputDeliveryOutboxRecord>();
  const persistence = {
    list: vi.fn(async () => [...records.values()]),
    stage: vi.fn(),
    stageBatch: vi.fn(async (rows: readonly InputDeliveryOutboxStageRequest[]) => {
      const staged = rows.map(row => ({ ...structuredClone(row), createdAt: new Date().toISOString() }));
      for (const row of staged) records.set(row.commandId, row); return staged;
    }),
    settle: vi.fn(async ({ commandId }: { commandId: string }) => { records.delete(commandId); })
  };
  const gateway = { execute: vi.fn(async (command: RuntimeCommand, _commandId?: string): Promise<RuntimeResult> => {
    if (command.kind === 'conversation.session.create') return { kind: 'conversation.session.created', sessionId: command.sessionId, version: 1 } as RuntimeResult;
    if (command.kind === 'conversation.message.accept') return { kind: 'conversation.message.accepted', sessionId: command.sessionId, messageId: command.messageId, sessionVersion: 2 } as RuntimeResult;
    throw new Error('unexpected command');
  }) };
  const binding: DraftDeliveryBinding = { submissionId, draftOwnerKey: 'fixture-new-owner', onStaged: vi.fn(async () => undefined), onSessionCreated: vi.fn(async () => undefined), canSelectSession: () => true };
  return { records, persistence, gateway, binding, controller: new ConversationInputDeliveryController(gateway, persistence) };
}
describe('original conversation input delivery owner', () => {
  it('stages the whole batch and waits for draft references before any dispatch, then retains envelopes until draft settlement', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.binding.onStaged).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.controller.send(requests(), f.binding); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.records.size).toBe(2); expect(f.gateway.execute).not.toHaveBeenCalled(); release();
    await expect(pending).resolves.toMatchObject({ messageId: submissionId, sessionId: 'session-a' });
    expect(f.persistence.settle).not.toHaveBeenCalled(); await f.controller.settleDraft(submissionId); expect(f.records.size).toBe(0);
  });
  it('does not send the message until new-session draft ownership migration completes', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.binding.onSessionCreated).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.controller.send(requests(), f.binding); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.gateway.execute).toHaveBeenCalledTimes(1); release(); await pending;
    expect(f.gateway.execute.mock.calls.map(row => row[1])).toEqual(['create-original', 'accept-original']);
  });
  it('reconciles a lost acceptance through original saved envelopes after window reconstruction without reconstructing from B', async () => {
    const f = fixture(), normal = f.gateway.execute.getMockImplementation()!;
    f.gateway.execute.mockImplementation(async (command, commandId) => {
      const result = await normal(command, commandId);
      if (command.kind === 'conversation.message.accept') throw new PublicResultError({ code: 'command_outcome_uncertain', message: 'lost response', retryable: true, correlationId: commandId! });
      return result;
    });
    await expect(f.controller.send(requests(), f.binding)).rejects.toMatchObject({ uncertain: true });
    expect(f.records.size).toBe(2); f.gateway.execute.mockImplementation(normal);
    const reconstructed = new ConversationInputDeliveryController(f.gateway, f.persistence);
    await reconstructed.reconcileDraft(submissionId, f.binding);
    expect(f.gateway.execute.mock.calls.map(row => row[1])).toEqual(['create-original', 'accept-original', 'create-original', 'accept-original']);
    expect(f.gateway.execute.mock.calls[3]![0]).toMatchObject({ content: 'A', messageId: submissionId });
    expect(f.persistence.settle).not.toHaveBeenCalled();
  });
  it('does not infer delivery from absent original envelopes', async () => {
    const f = fixture(); await expect(f.controller.reconcileDraft(submissionId, f.binding)).rejects.toThrow('original_message_missing');
    expect(f.gateway.execute).not.toHaveBeenCalled();
  });
  it('distinguishes confirmed Core rejection while retaining linked envelopes until failed draft persistence', async () => {
    const f = fixture(); f.gateway.execute.mockRejectedValueOnce(new PublicResultError({ code: 'version_conflict', message: 'rejected', retryable: false, correlationId: 'create-original' }));
    const error = await f.controller.send(requests(), f.binding).catch(error => error);
    expect(error).toBeInstanceOf(ConversationDeliveryError); expect(error.uncertain).toBe(false); expect(f.records.size).toBe(2);
    expect(f.persistence.settle).not.toHaveBeenCalled();
  });
});
