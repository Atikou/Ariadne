export interface ProductivityTaskRecoveryReferenceV1 {
  readonly faultId: string; readonly claimRevision: number; readonly commandId: string; readonly expectedRevision: number;
}
/** Indexed, body-free references to current or historical claims of the same owner. */
export interface ProductivityTaskRecoveryQueryV1 {
  queryTaskRecoveryClaims(workspaceId: string, ownerSessionId: string,
    claims: readonly { readonly faultId: string; readonly revision: number }[]): Promise<readonly ProductivityTaskRecoveryReferenceV1[]>;
}
