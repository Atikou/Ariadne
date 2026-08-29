import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpeechGateway } from '../src/main/speech/speech-gateway';

describe('SpeechGateway optional-module boundary', () => {
  it('degrades without throwing when an enabled module root has no runtime', async () => {
    const moduleRoot = await mkdtemp(join(tmpdir(), 'ariadne-missing-speech-'));
    const gateway = new SpeechGateway();
    await expect(gateway.initialize({
      enabled: true,
      moduleRoot,
      foregroundSttMode: 'compose',
      backgroundWakeEnabled: false,
      wakeKeywords: ['Ariadne'],
      listenWhenLocked: false,
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      activeVoiceId: 'zh-cn-melo-official',
      activeVoiceVersion: '1.0.0'
    })).resolves.toBeUndefined();
    expect(gateway.getStatus()).toMatchObject({
      availability: 'unavailable',
      capabilities: [],
      moduleRoot
    });
    await gateway.dispose();
  });

  it('fails closed to unavailable when the Sidecar protocol version is incompatible', async () => {
    const moduleRoot = await mkdtemp(join(tmpdir(), 'ariadne-incompatible-speech-'));
    const runtimeRoot = join(moduleRoot, 'runtime');
    await mkdir(join(runtimeRoot, 'dist'), { recursive: true });
    await copyFile(process.execPath, join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node'));
    await writeFile(join(runtimeRoot, 'dist', 'sidecar.mjs'), `
process.stdin.once('data', (chunk) => {
  const length = chunk.readUInt32BE(0);
  const request = JSON.parse(chunk.subarray(4, 4 + length).toString('utf8'));
  const payload = Buffer.from(JSON.stringify({
    type: 'response', protocolVersion: 2, requestId: request.requestId, ok: true, result: {}
  }));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
});
process.stdin.resume();
`, 'utf8');
    const gateway = new SpeechGateway();
    await expect(gateway.initialize({
      enabled: true, moduleRoot, foregroundSttMode: 'compose', backgroundWakeEnabled: false,
      wakeKeywords: ['Ariadne'], listenWhenLocked: false, inputDeviceId: 'default', outputDeviceId: 'default',
      activeVoiceId: null, activeVoiceVersion: null
    })).resolves.toBeUndefined();
    expect(gateway.getStatus()).toMatchObject({ availability: 'unavailable', capabilities: [] });
    await gateway.dispose();
  });
});
