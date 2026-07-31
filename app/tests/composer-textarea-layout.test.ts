import { describe, expect, it } from 'vitest';
import { calculateComposerTextareaLayout } from '../src/shared/composer-textarea-layout';

describe('composer textarea layout', () => {
  it('keeps the composer at two lines by default and grows with multiline content', () => {
    expect(calculateComposerTextareaLayout(22, 49, 144)).toEqual({
      height: 49,
      overflowY: 'hidden'
    });
    expect(calculateComposerTextareaLayout(92, 49, 144)).toEqual({
      height: 92,
      overflowY: 'hidden'
    });
  });

  it('caps tall content and enables internal scrolling', () => {
    expect(calculateComposerTextareaLayout(280, 49, 144)).toEqual({
      height: 144,
      overflowY: 'auto'
    });
  });
});
