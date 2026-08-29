import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionTtsAudio } from '../src/tts-audio-conditioner.mjs';

test('conditions quiet and loud speech toward one active RMS target', () => {
  const quiet = tone(0.04);
  const loud = tone(0.2);

  const quietResult = conditionTtsAudio(quiet, 16_000);
  const loudResult = conditionTtsAudio(loud, 16_000);

  assert.ok(quietResult.gainDb > 0);
  assert.ok(loudResult.gainDb < 0);
  assert.ok(Math.abs(activeRmsDbfs(quietResult.samples) - activeRmsDbfs(loudResult.samples)) < 0.1);
  assert.ok(Math.abs(activeRmsDbfs(quietResult.samples) - (-24)) < 0.1);
});

test('preserves silence and replaces non-finite samples safely', () => {
  const input = new Float32Array([0, Number.NaN, Number.POSITIVE_INFINITY, 0]);
  const result = conditionTtsAudio(input, 16_000);

  assert.deepEqual([...result.samples], [0, 0, 0, 0]);
  assert.equal(result.gainDb, 0);
  assert.equal(result.activeRmsDbfs, null);
  assert.ok(Number.isNaN(input[1]));
});

test('honors the peak ceiling when the requested gain would clip', () => {
  const input = tone(0.05);
  input[Math.floor(input.length / 2)] = 0.9;

  const result = conditionTtsAudio(input, 16_000, { targetActiveRmsDbfs: -10 });
  const peak = Math.max(...result.samples.map(Math.abs));

  assert.ok(peak <= 0.920001);
});

function tone(amplitude) {
  const sampleRate = 16_000;
  const samples = new Float32Array(sampleRate);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * 220 * index / sampleRate) * amplitude;
  }
  return samples;
}

function activeRmsDbfs(samples) {
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return 20 * Math.log10(Math.sqrt(sumSquares / samples.length));
}
