import { isAbsolute, resolve } from 'node:path';

import { APP_TERMINAL_CONTEXT_ID } from '@shared/contract';

export class TerminalWorkingDirectoryAuthority {
  private readonly appDataRoot: string;

  public constructor(
    appDataRoot: string,
    private readonly resolveAgentWorkspace: (workspaceId: string) => string
  ) {
    if (!isAbsolute(appDataRoot)) {
      throw new Error('terminal_app_data_root_must_be_absolute');
    }
    this.appDataRoot = resolve(appDataRoot);
  }

  public resolve(contextId: string): string {
    if (contextId === APP_TERMINAL_CONTEXT_ID) return this.appDataRoot;
    return this.resolveAgentWorkspace(contextId);
  }
}
