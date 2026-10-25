/** Private composition diagnostics. Fixed stage names carry no business data. */
export const RUNTIME_STARTUP_STAGES = [
  'bootstrap', 'communication_contract_preflight', 'legacy_control_preflight',
  'capability_manifest', 'command_journal', 'runtime_application', 'agent_control',
  'persistence_keyring', 'agent_store_open', 'conversation_store_open',
  'productivity_store_open', 'public_projection_store_open', 'persistence_ready',
  'projection_schema_open', 'projection_schema_validated', 'projection_history_audit',
  'projection_history_audited', 'projection_owner_ready',
  'projection_preparation_reclaim', 'projection_preparation_reclaimed',
  'projection_owner_lease', 'projection_owner_lease_acquired', 'projection_sqlite_open', 'projection_sqlite_opened',
  'projection_layout_validation', 'projection_layout_validated', 'projection_integrity_check', 'projection_integrity_checked',
  'projection_foreign_key_check', 'projection_foreign_keys_checked', 'projection_wal_configuration', 'projection_wal_configured',
  'inference_stream_reconcile', 'agent_observability', 'execution_pipeline_create',
  'agent_entity_create', 'agent_control_start', 'execution_start',
  'startup_projection_drain', 'startup_projection_drained', 'execution_started',
  'startup_workers', 'runtime_application_start', 'projection_wake_enable', 'ready', 'failed'
] as const;
export type RuntimeStartupStage = typeof RUNTIME_STARTUP_STAGES[number];

export interface RuntimeStartupTrace {
  bind(dataRoot: string): void;
  point(stage: RuntimeStartupStage): void;
}
