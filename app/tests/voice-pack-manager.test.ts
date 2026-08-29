import { describe, expect, it, vi } from 'vitest';
import { VoicePackManager } from '../src/main/speech/voice-pack-manager';

describe('VoicePackManager', () => {
  it('rejects non-absolute and non-avp import paths before extraction', async () => {
    const manager = new VoicePackManager('E:\\AI\\AriadneSpeech');
    await expect(manager.install('voice.zip', vi.fn())).rejects.toThrow('speech_voice_archive_invalid');
  });
});
