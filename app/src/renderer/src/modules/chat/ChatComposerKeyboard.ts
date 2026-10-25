export interface ComposerKeyState {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
}
export type ComposerKeyAction = 'native' | 'blocked' | 'next_turn' | 'next_step';

/** Composition owns its keys. No timer suppresses a subsequent ordinary Enter. */
export function composerKeyAction(event: ComposerKeyState, composing: boolean, enabled: boolean): ComposerKeyAction {
  if (composing || event.isComposing) return 'native';
  if (event.key !== 'Enter' || event.shiftKey) return 'native';
  if (event.repeat || !enabled) return 'blocked';
  return event.ctrlKey || event.metaKey ? 'next_step' : 'next_turn';
}
