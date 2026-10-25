/** Main-only proof from the original Runtime shutdown handshake, not an IPC path grant. */
export interface RuntimeMaintenanceBoundary {
  readonly runtimeInstanceId: string;
  readonly storageSchemas: Readonly<Record<string, number>>;
  readonly quiescedAt: string;
  readonly shutdownAcknowledged: true;
}
