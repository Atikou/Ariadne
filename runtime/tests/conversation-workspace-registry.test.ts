import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConversationWorkspaceRegistry } from '../src/application/ConversationWorkspaceRegistry.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConversationWorkspaceRegistry', () => {
  it('persists explicit session workspace ownership and defaults legacy sessions', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-conversation-workspace-'));
    temporaryRoots.push(root);
    const stateFile = path.join(root, 'conversation-workspaces.json');
    const first = new ConversationWorkspaceRegistry(stateFile, ['primary', 'secondary'], 'primary');

    expect(first.workspaceFor('legacy-session')).toBe('primary');
    first.assign('session-1', 'secondary');

    const restored = new ConversationWorkspaceRegistry(stateFile, ['primary', 'secondary'], 'primary');
    expect(restored.workspaceFor('session-1')).toBe('secondary');
    restored.remove('session-1');
    expect(restored.workspaceFor('session-1')).toBe('primary');
  });

  it('rejects assignments outside the authorized workspace catalog', () => {
    const registry = new ConversationWorkspaceRegistry(undefined, ['primary'], 'primary');
    expect(() => registry.assign('session-1', 'untrusted')).toThrow('conversation_workspace_not_authorized');
  });

  it('rolls back in-memory ownership when an atomic state write fails', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-conversation-workspace-failure-'));
    temporaryRoots.push(root);
    const stateFile = path.join(root, 'conversation-workspaces.json');
    const registry = new ConversationWorkspaceRegistry(stateFile, ['primary', 'secondary'], 'primary');

    mkdirSync(stateFile);
    expect(() => registry.assign('session-1', 'secondary')).toThrow();
    expect(registry.workspaceFor('session-1')).toBe('primary');

    rmSync(stateFile, { recursive: true, force: true });
    registry.assign('session-1', 'secondary');
    rmSync(stateFile, { force: true });
    mkdirSync(stateFile);

    expect(() => registry.remove('session-1')).toThrow();
    expect(registry.workspaceFor('session-1')).toBe('secondary');

    rmSync(stateFile, { recursive: true, force: true });
    registry.remove('session-1');
    expect(registry.workspaceFor('session-1')).toBe('primary');
  });

  it('keeps an authoritative deletion removed in memory and heals disk state on the next write', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-conversation-workspace-delete-'));
    temporaryRoots.push(root);
    const stateFile = path.join(root, 'conversation-workspaces.json');
    const registry = new ConversationWorkspaceRegistry(stateFile, ['primary', 'secondary'], 'primary');
    registry.assign('deleted-session', 'secondary');
    registry.assign('active-session', 'secondary');

    rmSync(stateFile, { force: true });
    mkdirSync(stateFile);
    expect(() => registry.removeAfterAuthoritativeDelete('deleted-session')).toThrow();
    expect(registry.workspaceFor('deleted-session')).toBe('primary');
    expect(registry.workspaceFor('active-session')).toBe('secondary');

    rmSync(stateFile, { recursive: true, force: true });
    registry.assign('later-session', 'secondary');
    const restored = new ConversationWorkspaceRegistry(stateFile, ['primary', 'secondary'], 'primary');
    expect(restored.workspaceFor('deleted-session')).toBe('primary');
    expect(restored.workspaceFor('active-session')).toBe('secondary');
    expect(restored.workspaceFor('later-session')).toBe('secondary');
  });
});
