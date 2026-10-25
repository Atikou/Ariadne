import type { DatabaseSync } from 'node:sqlite';
import type { ProductivityTaskRecoveryCommand, ProductivityTaskRecoveryResult } from '@ariadne/protocol/public';
import type { ProductivityTaskRecoveryClaimV1 } from '../../control/ports/ProductivityTaskIsolationV1.js';
import type { ProductivityTaskRecoveryAdmissionV1 } from '../../control/ports/ProductivityTaskRecoveryAuthorityV1.js';
import type { SqliteProductivityTaskIsolation } from './SqliteProductivityTaskIsolation.js';
import { commandReceiptIdentity } from './CommandReceiptIdentity.js';
import { readProductivityTaskRecoveryReceipt, productivityTaskRecoveryReceiptSchema } from './ProductivityTaskRecoveryReceipt.js';
import { productivityTaskRecoveryClaimReceiptSchema, taskRecoveryClaimReceiptId, readTaskRecoveryClaimReceipt } from './ProductivityTaskRecoveryClaimReceipt.js';
import type { ProductivityTaskRecoveryReferenceV1 } from '../../control/ports/ProductivityTaskRecoveryQueryV1.js';
import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';

type SourceClaim = NonNullable<ReturnType<SqliteProductivityTaskIsolation['readRecoveryClaim']>>;

/** Uses the existing command table and the same owner transaction. No second
 * command journal, SQL owner, task outcome or external execution path. */
export class SqliteProductivityTaskRecovery {
  public constructor(private readonly database: DatabaseSync, private readonly faults: SqliteProductivityTaskIsolation,
    private readonly subject: (source: SourceClaim) => ProductivityTaskRecoveryClaimV1) {}

  public begin(commandId: string, request: ProductivityTaskRecoveryCommand, now: Date): ProductivityTaskRecoveryAdmissionV1 {
    this.requireTransaction();
    const previous = this.read(commandId, request);
    if (previous?.phase === 'completed') return { kind: 'completed', result: previous.result };
    if (previous !== null) {
      const source = this.faults.readRecoveryClaim(request.workspaceId, request.sessionId, request.faultId, previous.claimFault.revision);
      if (source === null) return { kind: 'completed', result: this.finish(commandId, request, null, false, now) };
      return { kind: 'reconciling', claim: { ...this.subject(source), sourceDigest: previous.sourceDigest } };
    }
    const source = this.faults.beginReconcile(request.workspaceId, request.sessionId, request.faultId, request.expectedRevision, now);
    const receipt = productivityTaskRecoveryReceiptSchema.parse({ kind: 'productivity.task_recovery_receipt', contractVersion: '1.0',
      phase: 'reconciling', request, claimFault: source.fault, sourceDigest: source.sourceDigest });
    this.database.prepare('INSERT INTO productivity_commands(command_id,fingerprint,result_json,committed_at) VALUES(?,?,?,?)')
      .run(commandId, commandReceiptIdentity(request).fingerprint, JSON.stringify(receipt), now.toISOString());
    const pointer = productivityTaskRecoveryClaimReceiptSchema.parse({ kind: 'productivity.task_recovery_claim', contractVersion: '1.0',
      commandId, request, claimRevision: source.fault.revision });
    this.database.prepare('INSERT INTO productivity_commands(command_id,fingerprint,result_json,committed_at) VALUES(?,?,?,?)')
      .run(taskRecoveryClaimReceiptId(request.faultId, source.fault.revision), commandReceiptIdentity(request).fingerprint,
        JSON.stringify(pointer), now.toISOString());
    return { kind: 'reconciling', claim: this.subject(source) };
  }
  public finish(commandId: string, request: ProductivityTaskRecoveryCommand, claim: ProductivityTaskRecoveryClaimV1 | null,
    verified: boolean, now: Date): ProductivityTaskRecoveryResult {
    this.requireTransaction();
    const receipt = this.read(commandId, request);
    if (receipt === null) throw new Error('productivity_task_recovery_receipt_missing');
    if (receipt.phase === 'completed') return receipt.result;
    if (claim !== null && (claim.fault.revision !== receipt.claimFault.revision || claim.sourceDigest !== receipt.sourceDigest))
      throw new Error('productivity_task_recovery_claim_conflict');
    const current = this.faults.readFault(request.workspaceId, request.sessionId, request.faultId);
    const ownsClaim = current.state === 'reconciling' && current.revision === receipt.claimFault.revision;
    const fault = ownsClaim
      ? this.faults.finishReconcile(request.workspaceId, request.sessionId, request.faultId,
        receipt.claimFault.revision, receipt.sourceDigest, verified, now) : current;
    const result: ProductivityTaskRecoveryResult = { kind: 'productivity.task.reconciled', fault,
      outcome: !ownsClaim ? 'superseded' : fault.state === 'resolved' ? 'recovered' : 'unresolved' };
    const final = productivityTaskRecoveryReceiptSchema.parse({ ...receipt, phase: 'completed', result });
    const updated = this.database.prepare('UPDATE productivity_commands SET result_json=?,committed_at=? WHERE command_id=? AND result_json=?')
      .run(JSON.stringify(final), now.toISOString(), commandId, JSON.stringify(receipt));
    if (updated.changes !== 1) throw new Error('productivity_task_recovery_receipt_conflict');
    return result;
  }
  public read(commandId: string, request: ProductivityTaskRecoveryCommand) {
    this.requireTransaction();
    if (commandId.startsWith('task-claim-')) throw new Error('productivity_command_conflict');
    const row = this.database.prepare('SELECT fingerprint,result_json FROM productivity_commands WHERE command_id=?').get(commandId);
    if (row === undefined) return null;
    if (row.fingerprint !== commandReceiptIdentity(request).fingerprint) throw new Error('productivity_command_conflict');
    return readProductivityTaskRecoveryReceipt(String(row.result_json), String(row.fingerprint));
  }
  public pending(workspaceId: string, ownerSessionId: string, claims: readonly { readonly faultId: string; readonly revision: number }[]) {
    this.requireTransaction();
    if (claims.length > 128 || new Set(claims.map(claim => claim.faultId)).size !== claims.length) throw new Error('productivity_task_recovery_page_invalid');
    const result: ProductivityTaskRecoveryReferenceV1[] = [];
    for (const claim of claims) {
      const fault = this.faults.readFault(workspaceId, ownerSessionId, claim.faultId);
      if (fault.revision < claim.revision) continue;
      const key = taskRecoveryClaimReceiptId(fault.faultId, claim.revision);
      const row = this.database.prepare('SELECT fingerprint,result_json FROM productivity_commands WHERE command_id=?').get(key);
      if (row === undefined) {
        if (fault.state === 'reconciling' && fault.revision === claim.revision)
          throw markAuthorityIntegrityError('productivity', new Error('productivity_task_recovery_claim_receipt_missing'));
        continue;
      }
      const pointer = readTaskRecoveryClaimReceipt(String(row.result_json), key, String(row.fingerprint));
      const receipt = this.read(pointer.commandId, pointer.request);
      if (pointer.request.workspaceId !== workspaceId || pointer.request.sessionId !== ownerSessionId
        || receipt === null || receipt.claimFault.revision !== claim.revision)
        throw markAuthorityIntegrityError('productivity', new Error('productivity_task_recovery_claim_receipt_conflict'));
      result.push({ faultId: fault.faultId, claimRevision: claim.revision, commandId: pointer.commandId, expectedRevision: pointer.request.expectedRevision });
    }
    return result;
  }
  private requireTransaction(): void {
    if (!this.database.isTransaction) throw new Error('productivity_task_recovery_transaction_required');
  }
}
