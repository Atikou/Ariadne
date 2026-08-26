/** Stable public authority identity for the production Runtime Tool Catalog. */
export const FIRST_PARTY_AGENT_TOOL_CATALOG_ID = 'ariadne.workspace-tools' as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION = 5 as const;
export const FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST =
  'sha256:85a827b92203d736ede7dc0fc40db07be804666f95729940ac870c928567e808' as const;
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
  'workspace.list_files',
  'workspace.read_file',
  'workspace.run_command',
  'workspace.write_file'
] as const);
