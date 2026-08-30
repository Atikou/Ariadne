export interface AgentSubagentSessionOwner {
  readonly runId: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly configurationDigest: string;
}

export interface AgentSubagentSessionRecord extends AgentSubagentSessionOwner {
  readonly remoteSessionId: string;
  readonly reconnectMethod: 'resume' | 'load';
  readonly createdAt: string;
}

/** Provider-private continuation state; remote identities never enter Projection or model input. */
export interface AgentSubagentSessionStore {
  read(owner: AgentSubagentSessionOwner): Promise<AgentSubagentSessionRecord | null>;
  bind(record: AgentSubagentSessionRecord): Promise<void>;
  remove(owner: AgentSubagentSessionOwner): Promise<void>;
}
