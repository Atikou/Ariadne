/** Stable public authority identity for the production Runtime Tool Catalog. */
export const FIRST_PARTY_AGENT_TOOL_CATALOG_ID = 'ariadne.workspace-tools' as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION = 17 as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST =
  'sha256:59e1c7a04d381e6f62edd0be82e9c092a26f6d60edc6ca7b4b8b74d038ed9384' as const;
export const FIRST_PARTY_AGENT_TOOL_NAMES = Object.freeze([
  'browser.accessibility_snapshot',
  'browser.click',
  'browser.download',
  'browser.navigate',
  'browser.screenshot',
  'browser.scroll',
  'browser.type',
  'browser.wait',
  'computer.list_directory',
  'computer.open_path',
  'computer.read_text_file',
  'mcp.call_tool',
  'mcp.list_servers',
  'mcp.list_tools',
  'skill.load',
  'skill.resource.read',
  'workspace.apply_text_edits',
  'workspace.effect_result_read',
  'workspace.glob',
  'workspace.job_kill',
  'workspace.job_list',
  'workspace.job_output',
  'workspace.job_resize',
  'workspace.job_signal',
  'workspace.job_wait',
  'workspace.job_write',
  'workspace.list_files',
  'workspace.process_start',
  'workspace.read_file',
  'workspace.run_command',
  'workspace.search_text',
  'workspace.terminal_start',
  'workspace.write_file'
] as const);
