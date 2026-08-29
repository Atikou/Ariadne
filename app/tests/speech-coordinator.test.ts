import { describe, expect, it } from 'vitest';
import { splitSpeakableSegments } from '../src/renderer/src/core/speech/speech-coordinator';

describe('speech sentence segmentation', () => {
  it('flushes Chinese punctuation in order', () => {
    expect(splitSpeakableSegments('第一句。第二句！尚未结束', false)).toEqual({
      ready: ['第一句。', '第二句！'],
      remainder: '尚未结束'
    });
  });

  it('uses the hard 80-character boundary', () => {
    const result = splitSpeakableSegments('语'.repeat(85), false);
    expect(result.ready).toEqual(['语'.repeat(80)]);
    expect(result.remainder).toBe('语'.repeat(5));
  });

  it('flushes a short remainder only at final or idle', () => {
    expect(splitSpeakableSegments('最后一句', false).ready).toEqual([]);
    expect(splitSpeakableSegments('最后一句', true).ready).toEqual(['最后一句']);
  });
});
