import {
  PUBLIC_PROJECTION_CONTRACT_VERSION
} from '@ariadne/protocol/public';
import type { AriadneApi } from '@shared/contract';
import type { AgentInputDeliveryReceipt, VerifiedAgentInboxIdentity } from '../agent-input-delivery';
import type { RuntimeRun } from '../runtime-projection-presenter';
import { AgentInputDeliveryController } from './agent-input-delivery-controller';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import type { RunFeatureHost } from './run-feature-host';
import type { SnapshotSource } from './feature-snapshot-store';
import type { RunFeatureSnapshot, SubagentReference } from './projection-feature-snapshots';
export type { RunFeatureSnapshot } from './projection-feature-snapshots';
import { RunDocumentFeatureReads, type RunDetailActions } from './run-document-feature-reads';
import type { DraftDeliveryBinding } from './input-delivery-binding';

export class RunFeatureStore extends RunDocumentFeatureReads {
  private readonly deliveries: AgentInputDeliveryController;
  readonly deliveryPersistenceConfigured: boolean;

  constructor(
    private readonly gateway: RuntimeFeatureCommandGateway,
    private readonly host: RunFeatureHost,
    readonly view: SnapshotSource<RunFeatureSnapshot>,
    persistence?: AriadneApi['inputDeliveryOutbox'],
    readActions?: RunDetailActions
  ) {
    super(readActions);
    this.deliveryPersistenceConfigured = persistence !== undefined;
    this.deliveries = new AgentInputDeliveryController(gateway, host, persistence);
  }

  deliverySnapshot(): AgentInputDeliveryReceipt[] {
    return this.deliveries.snapshot();
  }

  get deliveryPersistenceError(): string | null {
    return this.deliveries.persistenceError;
  }

  observeVerifiedInboxIdentities(identities: readonly VerifiedAgentInboxIdentity[]): void {
    this.deliveries.observeInboxIdentities(identities);
  }

  restoreDeliveryPersistence(generation: number): Promise<void> {
    return this.deliveries.restorePersistence(generation);
  }

  async requestCancellation(run: Pick<RuntimeRun, 'runId' | 'origin'>): Promise<void> {
    if (run.origin !== 'projection') throw new Error('projection_run_action_unavailable:origin');
    const authoritative = this.host.projectionRuns().find((candidate) => candidate.runId === run.runId);
    if (authoritative === undefined) throw new Error('projection_run_action_unavailable:missing');
    const result = await this.gateway.execute({
      kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId, expectedVersion: authoritative.version,
      occurredAt: new Date().toISOString(), reason: 'user_requested'
    });
    if ((result.kind !== 'agent.run.cancelled' && result.kind !== 'agent.run.cancellation.requested') || result.runId !== run.runId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.host.synchronize();
  }

  async enqueueInput(
    run: RuntimeRun,
    content: string,
    delivery: 'next_turn' | 'next_step',
    draft?: DraftDeliveryBinding
  ): Promise<AgentInputDeliveryReceipt> {
    this.requireCapability('agent.inbox');
    if (run.origin !== 'projection' || run.sessionId === undefined) {
      throw new Error('projection_run_action_unavailable:inbox');
    }
    return this.deliveries.enqueue(run.runId, run.sessionId, content, delivery, draft);
  }

  reconcileInputDelivery(commandId: string): Promise<AgentInputDeliveryReceipt> {
    return this.deliveries.reconcile(commandId);
  }

  settleDraftDelivery(commandId: string, submissionId: string): Promise<void> {
    return this.deliveries.settleDraftDelivery(commandId, submissionId);
  }

  dismissInputDelivery(commandId: string): void {
    this.deliveries.dismiss(commandId);
  }

  async sendSubagentInput(parent: RuntimeRun, child: SubagentReference, content: string): Promise<string> {
    this.requireSubagent(parent, child);
    const inputId = crypto.randomUUID();
    const result = await this.gateway.execute({
      kind: 'agent.subagent.send', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: parent.runId, childRunId: child.runId,
      sessionId: parent.sessionId!, inputId, content
    });
    if (result.kind !== 'agent.subagent.input.sent'
      || result.parentRunId !== parent.runId
      || result.childRunId !== child.runId
      || result.inputId !== inputId) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.host.synchronize();
    return inputId;
  }

  async interruptSubagent(parent: RuntimeRun, child: SubagentReference): Promise<void> {
    this.requireSubagent(parent, child);
    const result = await this.gateway.execute({
      kind: 'agent.subagent.interrupt', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: parent.runId, childRunId: child.runId,
      sessionId: parent.sessionId!, expectedChildVersion: 'version' in child ? child.version : child.aggregateVersion,
      occurredAt: new Date().toISOString(), reason: 'user_requested'
    });
    if (result.kind !== 'agent.subagent.interrupted'
      || result.parentRunId !== parent.runId
      || result.childRunId !== child.runId) throw new Error(`runtime_result_invalid:${result.kind}`);
    void this.host.synchronize();
  }

  async replaceInput(
    run: RuntimeRun,
    inputId: string,
    expectedInputVersion: number,
    content: string
  ): Promise<void> {
    this.requireInboxRun(run);
    const result = await this.gateway.execute({
      kind: 'agent.inbox.replace', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId, inputId, expectedInputVersion, content
    });
    if (result.kind !== 'agent.inbox.replaced' || result.inputId !== inputId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.host.synchronize();
  }

  async removeInput(
    run: RuntimeRun,
    inputId: string,
    expectedInputVersion: number
  ): Promise<void> {
    this.requireInboxRun(run);
    const result = await this.gateway.execute({
      kind: 'agent.inbox.remove', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId, inputId, expectedInputVersion
    });
    if (result.kind !== 'agent.inbox.removed' || result.inputId !== inputId) {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    void this.host.synchronize();
  }

  private requireCapability(capability: 'agent.inbox' | 'agent.subagents'): void {
    if (!this.host.hasCapability(capability)) throw new Error(`runtime_capability_missing:${capability}`);
  }

  private requireInboxRun(run: RuntimeRun): void {
    this.requireCapability('agent.inbox');
    if (run.origin !== 'projection') throw new Error('projection_run_action_unavailable:inbox');
  }

  private requireSubagent(parent: RuntimeRun, child: SubagentReference): void {
    this.requireCapability('agent.subagents');
    if (parent.origin !== 'projection' || ('origin' in child && child.origin !== 'projection')
      || parent.sessionId === undefined || child.sessionId !== parent.sessionId
      || child.parentRunId !== parent.runId || child.subagentMode !== 'continuable') {
      throw new Error('projection_run_action_unavailable:subagent');
    }
  }
}
