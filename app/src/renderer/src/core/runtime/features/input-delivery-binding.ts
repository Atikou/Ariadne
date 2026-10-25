/** Renderer editing-owner callbacks, never fields of a Runtime command. */
export interface DraftDeliveryBinding {
  readonly submissionId: string;
  readonly draftOwnerKey: string;
  readonly onStaged: (commandIds: readonly string[]) => Promise<void>;
  /** Run the sender's selection callback after durable owner migration, before
   * publishing the new draft key to React. It still checks current selection. */
  readonly onSessionCreated: (sessionId: string, afterMove?: () => void) => Promise<void>;
  readonly canSelectSession: () => boolean;
}
