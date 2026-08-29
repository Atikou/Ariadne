const DEFAULT_TARGET_ACTIVE_RMS_DBFS = -24;
const DEFAULT_MAX_GAIN_DB = 9;
const DEFAULT_MAX_ATTENUATION_DB = 9;
const DEFAULT_PEAK_LIMIT = 0.92;
const ACTIVE_FRAME_FLOOR_DBFS = -50;
const ACTIVE_FRAME_RANGE_DB = 24;
const FRAME_SECONDS = 0.02;

export function conditionTtsAudio(samples, sampleRate, options = {}) {
  if (!(samples instanceof Float32Array)) throw new TypeError('TTS samples must be a Float32Array.');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('TTS sample rate must be positive.');

  const output = new Float32Array(samples);
  if (output.length === 0) return { samples: output, gainDb: 0, activeRmsDbfs: null };

  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frames = [];
  let peak = 0;
  for (let offset = 0; offset < output.length; offset += frameSize) {
    const end = Math.min(output.length, offset + frameSize);
    let sumSquares = 0;
    for (let index = offset; index < end; index += 1) {
      const value = Number.isFinite(output[index]) ? output[index] : 0;
      output[index] = value;
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - offset));
    frames.push({ offset, end, rms, dbfs: amplitudeToDbfs(rms) });
  }

  const loudestFrameDbfs = Math.max(...frames.map((frame) => frame.dbfs));
  if (!Number.isFinite(loudestFrameDbfs) || loudestFrameDbfs < ACTIVE_FRAME_FLOOR_DBFS) {
    return { samples: output, gainDb: 0, activeRmsDbfs: null };
  }

  const gateDbfs = Math.max(ACTIVE_FRAME_FLOOR_DBFS, loudestFrameDbfs - ACTIVE_FRAME_RANGE_DB);
  let activeSumSquares = 0;
  let activeSampleCount = 0;
  for (const frame of frames) {
    if (frame.dbfs < gateDbfs) continue;
    for (let index = frame.offset; index < frame.end; index += 1) {
      activeSumSquares += output[index] * output[index];
      activeSampleCount += 1;
    }
  }
  if (activeSampleCount === 0) return { samples: output, gainDb: 0, activeRmsDbfs: null };

  const activeRmsDbfs = amplitudeToDbfs(Math.sqrt(activeSumSquares / activeSampleCount));
  const targetDbfs = finiteOption(options.targetActiveRmsDbfs, DEFAULT_TARGET_ACTIVE_RMS_DBFS);
  const maxGainDb = Math.max(0, finiteOption(options.maxGainDb, DEFAULT_MAX_GAIN_DB));
  const maxAttenuationDb = Math.max(0, finiteOption(options.maxAttenuationDb, DEFAULT_MAX_ATTENUATION_DB));
  let gainDb = Math.max(-maxAttenuationDb, Math.min(maxGainDb, targetDbfs - activeRmsDbfs));
  let gain = 10 ** (gainDb / 20);

  const peakLimit = Math.max(0.1, Math.min(1, finiteOption(options.peakLimit, DEFAULT_PEAK_LIMIT)));
  if (peak > 0 && peak * gain > peakLimit) {
    gain = peakLimit / peak;
    gainDb = 20 * Math.log10(gain);
  }

  for (let index = 0; index < output.length; index += 1) output[index] *= gain;
  return { samples: output, gainDb, activeRmsDbfs };
}

function amplitudeToDbfs(value) {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

function finiteOption(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
