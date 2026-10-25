import { describe, expect, it } from 'vitest';
import { composerKeyAction, type ComposerKeyState } from '../src/renderer/src/modules/chat/ChatComposerKeyboard';
const enter: ComposerKeyState = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, repeat: false };
describe('one composer shortcut policy', () => {
  it('leaves composition Enter, including modified Enter, to the input method', () => {
    expect(composerKeyAction(enter, true, true)).toBe('native');
    expect(composerKeyAction({ ...enter, isComposing: true, ctrlKey: true }, false, true)).toBe('native');
    expect(composerKeyAction({ ...enter, isComposing: true, metaKey: true }, false, false)).toBe('native');
  });
  it('allows the first ordinary Enter immediately after composition ends without a timer', () => {
    expect(composerKeyAction(enter, false, true)).toBe('next_turn');
  });
  it('keeps Shift Enter native for a newline even with another modifier', () => {
    expect(composerKeyAction({ ...enter, shiftKey: true }, false, true)).toBe('native');
    expect(composerKeyAction({ ...enter, shiftKey: true, ctrlKey: true }, false, true)).toBe('native');
  });
  it('routes Ctrl and Meta Enter through the next-step submission entry', () => {
    expect(composerKeyAction({ ...enter, ctrlKey: true }, false, true)).toBe('next_step');
    expect(composerKeyAction({ ...enter, metaKey: true }, false, true)).toBe('next_step');
  });
  it('blocks repeated or disabled ordinary submission without cancelling composition', () => {
    expect(composerKeyAction({ ...enter, repeat: true }, false, true)).toBe('blocked');
    expect(composerKeyAction(enter, false, false)).toBe('blocked');
    expect(composerKeyAction({ ...enter, repeat: true }, true, false)).toBe('native');
    expect(composerKeyAction({ ...enter, key: 'a' }, false, false)).toBe('native');
  });
});
