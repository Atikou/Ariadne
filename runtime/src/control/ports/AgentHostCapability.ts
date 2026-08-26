export interface AgentHostCapabilityClient {
  request(
    operation: Readonly<Record<string, unknown>>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>;
}
