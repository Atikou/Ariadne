/** Stable public authority identity for the production Runtime Tool Catalog. */
export const FIRST_PARTY_AGENT_TOOL_CATALOG_ID = 'ariadne.workspace-tools' as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION = 7 as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST =
  'sha256:ceb8c9bc069bd29465bfef64db4aace9a2b62fd9bc24c21ecfdffaac990e2de1' as const;
export const FIRST_PARTY_AGENT_TOOL_NAMES = Object.freeze([
  'browser.accessibility_snapshot',
  'browser.click',
  'browser.download',
  'browser.navigate',
  'browser.screenshot',
  'browser.scroll',
  'browser.type',
  'browser.wait',
  'mcp.call_tool',
  'mcp.list_servers',
  'mcp.list_tools',
  'skill.load',
  'workspace.list_files',
  'workspace.process_list',
  'workspace.process_read',
  'workspace.process_start',
  'workspace.process_stop',
  'workspace.process_write',
  'workspace.read_file',
  'workspace.run_command',
  'workspace.write_file'
] as const);
