export const IPC_CHANNELS = {
  clipboardWrite: 'ariadne:clipboard:write',
  layoutLoad: 'ariadne:layout:load',
  layoutSave: 'ariadne:layout:save',
  preferencesLoad: 'ariadne:preferences:load',
  preferencesUpdate: 'ariadne:preferences:update',
  systemCapabilityStatuses: 'ariadne:system:capability-statuses',
  systemGameActivity: 'ariadne:system:game-activity',
  terminalCreate: 'ariadne:terminal:create',
  terminalWrite: 'ariadne:terminal:write',
  terminalResize: 'ariadne:terminal:resize',
  terminalClose: 'ariadne:terminal:close',
  terminalData: 'ariadne:terminal:data',
  terminalExit: 'ariadne:terminal:exit',
  workspaceListDirectory: 'ariadne:workspace:list-directory',
  windowHide: 'ariadne:window:hide',
  windowShow: 'ariadne:window:show',
  windowTitleBarTheme: 'ariadne:window:title-bar-theme'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
