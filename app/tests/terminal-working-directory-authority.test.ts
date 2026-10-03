import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { APP_TERMINAL_CONTEXT_ID } from '../src/shared/contract';
import { TerminalWorkingDirectoryAuthority } from '../src/main/services/terminal-working-directory-authority';

describe('TerminalWorkingDirectoryAuthority', () => {
  it('owns a stable App directory without inventing an Agent workspace', () => {
    const resolveAgentWorkspace = vi.fn(() => 'E:\\Project\\Agent');
    const authority = new TerminalWorkingDirectoryAuthority(
      'C:\\Users\\Administrator\\AppData\\Roaming\\Ariadne',
      resolveAgentWorkspace
    );

    expect(authority.resolve(APP_TERMINAL_CONTEXT_ID)).toBe(
      path.resolve('C:\\Users\\Administrator\\AppData\\Roaming\\Ariadne')
    );
    expect(resolveAgentWorkspace).not.toHaveBeenCalled();
  });

  it('resolves an explicit recovered Agent workspace through its existing authority', () => {
    const resolveAgentWorkspace = vi.fn(() => 'E:\\Project\\Agent');
    const authority = new TerminalWorkingDirectoryAuthority(
      'C:\\Users\\Administrator\\AppData\\Roaming\\Ariadne',
      resolveAgentWorkspace
    );

    expect(authority.resolve('workspace-agent')).toBe('E:\\Project\\Agent');
    expect(resolveAgentWorkspace).toHaveBeenCalledWith('workspace-agent');
  });
});
