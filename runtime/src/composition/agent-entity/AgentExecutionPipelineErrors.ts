export class ProductionAgentControlExecutionPipelineError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_EXECUTION_PIPELINE_OPTIONS_INVALID'
      | 'AGENT_EXECUTION_TOOL_CATALOG_MISSING'
      | 'AGENT_EXECUTION_TOOL_CATALOG_INVALID',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ProductionAgentControlExecutionPipelineError';
  }
}

export class AgentControlConversationMessageAdmissionError extends Error {
  public readonly code = 'AGENT_EXECUTION_ADMISSION_UNAVAILABLE';

  public constructor(
    public readonly reason:
      | 'workspace_authority_missing'
      | 'authority_expired'
      | 'tool_catalog_unavailable'
      | 'model_binding_unavailable'
  ) {
    super('Agent execution admission is unavailable.');
    this.name = 'AgentControlConversationMessageAdmissionError';
  }
}
