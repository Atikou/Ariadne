/** Stable public authority identity for the production Runtime Tool Catalog. */
export const FIRST_PARTY_AGENT_TOOL_CATALOG_ID = 'ariadne.workspace-tools' as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION = 6 as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST =
  'sha256:63619c0f22e7584c5ddbce7d3a80d593de476088050275ad3adb4eced6b460c4' as const;
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
  'workspace.read_file',
  'workspace.run_command',
  'workspace.write_file'
] as const);
