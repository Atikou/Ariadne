export const IPC_CHANNELS = {
  agentSettingsLoad: 'ariadne:agent-settings:load',
  agentSettingsUpdate: 'ariadne:agent-settings:update',
  clipboardWrite: 'ariadne:clipboard:write',
  layoutLoad: 'ariadne:layout:load',
  layoutSave: 'ariadne:layout:save',
  preferencesLoad: 'ariadne:preferences:load',
  preferencesUpdate: 'ariadne:preferences:update',
  runtimeStatus: 'ariadne:runtime:status',
  runtimeRequest: 'ariadne:runtime:request',
  runtimeEvent: 'ariadne:runtime:event',
  systemCapabilityStatuses: 'ariadne:system:capability-statuses',
  systemGameActivity: 'ariadne:system:game-activity',
  terminalCreate: 'ariadne:terminal:create',
  terminalWrite: 'ariadne:terminal:write',
  terminalResize: 'ariadne:terminal:resize',
  terminalClose: 'ariadne:terminal:close',
  terminalData: 'ariadne:terminal:data',
  terminalExit: 'ariadne:terminal:exit',
  workspaceOpenDirectory: 'ariadne:workspace:open-directory',
  workspaceListDirectory: 'ariadne:workspace:list-directory',
  windowHide: 'ariadne:window:hide',
  windowShow: 'ariadne:window:show',
  windowTitleBarTheme: 'ariadne:window:title-bar-theme'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
