import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { conditionTtsAudio } from './tts-audio-conditioner.mjs';

const require = createRequire(import.meta.url);

export class SherpaEngine {
  #root;
  #emit;
  #sherpa = null;
  #cpal = null;
  #config = null;
  #recognizer = null;
  #vad = null;
  #kws = null;
  #tts = null;
  #voiceIdentity = null;
  #voiceSpeakerId = 0;
  #inputStream = null;
  #mode = 'idle';
  #request = null;
  #recognizerStream = null;
  #kwsStream = null;
  #resampler = null;
  #vadBuffer = null;
  #lastPartial = '';
  #output = null;
  #ttsCancellation = 0;

  constructor(root, emit) {
    this.#root = root;
    this.#emit = emit;
  }

  async initialize() {
    try {
      this.#sherpa = require('sherpa-onnx-node');
      this.#cpal = require('node-cpal');
    } catch (error) {
      process.stderr.write(`Speech dependency unavailable: ${error.message}\n`);
    }
    await this.#loadRecognitionModels();
  }

  status() {
    const capabilities = [];
    if (this.#recognizer && this.#vad && this.#cpal) capabilities.push('stt');
    if (this.#kws && this.#cpal) capabilities.push('kws');
    if (this.#sherpa) capabilities.push('voice-pack');
    if (this.#tts && this.#cpal) capabilities.push('tts');
    const available = capabilities.length > 0;
    return {
      availability: available ? (capabilities.includes('stt') && capabilities.includes('tts') ? 'available' : 'degraded') : 'unavailable',
      activity: activityForMode(this.#mode),
      detail: available
        ? `sherpa-onnx CPU engine ready (${capabilities.join(', ')}).`
        : 'Install runtime dependencies and model assets to enable speech.',
      capabilities,
      inputDevices: this.#audioDevices(true),
      outputDevices: this.#audioDevices(false)
    };
  }

  async configure(config) {
    this.#config = structuredClone(config);
    if (config.activeVoice) await this.loadVoice(config.activeVoice);
    await this.#configureKeywords(config.wakeKeywords ?? ['Ariadne']);
    this.#reconcileKeywordListening();
  }

  async startRecognition(request) {
    if (!this.#recognizer || !this.#vad || !this.#cpal) throw new Error('stt_unavailable');
    this.#stopInput();
    this.#mode = 'stt';
    this.#request = request;
    this.#recognizerStream = this.#recognizer.createStream();
    this.#lastPartial = '';
    this.#openInput((samples, sampleRate) => this.#acceptRecognitionAudio(samples, sampleRate));
    this.#emitStatus();
  }

  async stopRecognition(request) {
    if (this.#request?.requestId !== request.requestId) return;
    this.#finishRecognition();
  }

  async cancelRecognition() {
    this.#request = null;
    this.#recognizerStream = null;
    this.#stopInput();
    this.#mode = 'idle';
    this.#reconcileKeywordListening();
    this.#emitStatus();
  }

  async testVoice(payload) {
    const candidate = await this.#createTts(payload);
    const audio = await candidate.generateAsync({
      text: '你好，欢迎使用 Ariadne。',
      generationConfig: new this.#sherpa.GenerationConfig({ sid: payload.manifest.speakerId ?? 0, speed: 1.0 })
    });
    if (!audio?.samples?.length || !audio.sampleRate) throw new Error('voice_test_audio_empty');
  }

  async loadVoice(payload) {
    const identity = `${payload.manifest.voiceId}@${payload.manifest.version}`;
    if (this.#voiceIdentity === identity && this.#tts) return;
    this.#tts = await this.#createTts(payload);
    this.#voiceIdentity = identity;
    this.#voiceSpeakerId = payload.manifest.speakerId ?? 0;
    this.#emitStatus();
  }

  async synthesize(request) {
    if (!this.#tts || !this.#cpal) throw new Error('tts_unavailable');
    const cancellation = this.#ttsCancellation;
    this.#mode = 'tts';
    this.#emit({ kind: 'tts.started', turnId: request.turnId });
    this.#emitStatus();
    // Do not use the native onProgress callback: sherpa-onnx-node versions prior
    // to the verified fix can free callback buffers before the JS queue drains.
    const audio = await this.#tts.generateAsync({
      text: request.text,
      generationConfig: new this.#sherpa.GenerationConfig({ sid: this.#voiceSpeakerId, speed: 1.0 })
    });
    if (cancellation !== this.#ttsCancellation) return;
    const conditioned = conditionTtsAudio(audio.samples, audio.sampleRate);
    await this.#play(conditioned.samples, audio.sampleRate, cancellation);
    if (cancellation !== this.#ttsCancellation) return;
    this.#emit({ kind: 'tts.segment-completed', turnId: request.turnId, sequence: request.sequence });
    if (request.final) this.#emit({ kind: 'tts.completed', turnId: request.turnId });
    this.#mode = 'idle';
    this.#reconcileKeywordListening();
    this.#emitStatus();
  }

  async cancelSynthesis(request = {}) {
    this.#ttsCancellation += 1;
    const output = this.#output;
    this.#output = null;
    if (output) {
      clearTimeout(output.timer);
      this.#cpal.closeStream(output.stream);
      output.resolve();
    }
    this.#mode = 'idle';
    this.#emit({ kind: 'tts.cancelled', turnId: request.turnId ?? null });
    this.#reconcileKeywordListening();
    this.#emitStatus();
  }

  async shutdown() {
    await this.cancelSynthesis();
    this.#stopInput();
  }

  async #loadRecognitionModels() {
    if (!this.#sherpa) return;
    try {
      const sttRoot = join(this.#root, 'models', 'stt');
      const model = parseJson(await readFile(join(sttRoot, 'model.json'), 'utf8'));
      this.#recognizer = new this.#sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: resolve(sttRoot, model.encoder),
            decoder: resolve(sttRoot, model.decoder),
            joiner: resolve(sttRoot, model.joiner)
          },
          tokens: resolve(sttRoot, model.tokens),
          numThreads: 4,
          provider: 'cpu',
          debug: false
        },
        decodingMethod: 'greedy_search',
        maxActivePaths: 4,
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.0,
        rule3MinUtteranceLength: 20
      });
      this.#vad = new this.#sherpa.Vad({
        sileroVad: {
          model: join(this.#root, 'models', 'vad', 'silero_vad.onnx'),
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: 0.6,
          windowSize: 512
        },
        sampleRate: 16000,
        numThreads: 1,
        debug: false
      }, 60);
      this.#vadBuffer = new this.#sherpa.CircularBuffer(16000 * 30);
    } catch (error) {
      process.stderr.write(`STT/VAD unavailable: ${error.message}\n`);
    }
    try {
      const kwsRoot = join(this.#root, 'models', 'kws');
      const model = parseJson(await readFile(join(kwsRoot, 'model.json'), 'utf8'));
      this.#kws = this.#createKeywordSpotter(kwsRoot, model);
    } catch (error) {
      process.stderr.write(`KWS unavailable: ${error.message}\n`);
    }
  }

  async #configureKeywords(keywords) {
    if (!this.#kws || !this.#sherpa) return;
    const kwsRoot = join(this.#root, 'models', 'kws');
    const rawPath = join(kwsRoot, 'keywords.raw.txt');
    const outputPath = join(kwsRoot, 'keywords.txt');
    const normalized = [...new Set(keywords.map((value) => value.trim()).filter(Boolean))];
    await mkdir(kwsRoot, { recursive: true });
    await writeFile(rawPath, normalized.map((value) => `${value} @${value.replaceAll(' ', '_')}`).join('\n') + '\n', 'utf8');
    const compiler = join(this.#root, 'runtime', 'tools', 'compile-keywords.mjs');
    if (!await exists(compiler)) {
      process.stderr.write('KWS keyword compiler unavailable; keeping the previously compiled keyword set.\n');
      return;
    }
    const model = parseJson(await readFile(join(kwsRoot, 'model.json'), 'utf8'));
    await run(process.execPath, [compiler,
      '--tokens', resolve(kwsRoot, model.tokens),
      '--lexicon', resolve(kwsRoot, model.lexicon ?? 'en.phone'),
      '--input', rawPath,
      '--output', outputPath
    ]);
    const wasListening = this.#mode === 'kws';
    if (wasListening) {
      this.#stopInput();
      this.#mode = 'idle';
    }
    this.#kws = this.#createKeywordSpotter(kwsRoot, model);
    if (wasListening) this.#reconcileKeywordListening();
  }

  #createKeywordSpotter(kwsRoot, model) {
    return new this.#sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: resolve(kwsRoot, model.encoder),
          decoder: resolve(kwsRoot, model.decoder),
          joiner: resolve(kwsRoot, model.joiner)
        },
        tokens: resolve(kwsRoot, model.tokens),
        numThreads: 1,
        provider: 'cpu',
        debug: false
      },
      keywordsFile: join(kwsRoot, 'keywords.txt'),
      maxActivePaths: 4,
      keywordsScore: 1.5,
      keywordsThreshold: 0.25
    });
  }

  #reconcileKeywordListening() {
    const shouldListen = Boolean(
      this.#config?.backgroundWakeEnabled
      && this.#config?.background
      && this.#config?.listenAllowed
      && this.#kws
      && this.#cpal
      && this.#mode === 'idle'
    );
    if (!shouldListen) {
      if (this.#mode === 'kws') {
        this.#stopInput();
        this.#mode = 'idle';
      }
      return;
    }
    this.#mode = 'kws';
    this.#kwsStream = this.#kws.createStream();
    this.#openInput((samples, sampleRate) => this.#acceptKeywordAudio(samples, sampleRate));
    this.#emitStatus();
  }

  #openInput(accept) {
    const device = this.#selectDevice(true);
    const config = this.#cpal.getDefaultInputConfig(device.deviceId);
    const nativeRate = config.sampleRate;
    this.#resampler = new this.#sherpa.LinearResampler(nativeRate, 16000);
    this.#inputStream = this.#cpal.createStream(device.deviceId, true, {
      sampleRate: nativeRate,
      channels: 1,
      format: 'f32'
    }, (data) => accept(this.#resampler.resample(data), 16000));
  }

  #stopInput() {
    if (this.#inputStream && this.#cpal) this.#cpal.closeStream(this.#inputStream);
    this.#inputStream = null;
    this.#resampler = null;
    this.#kwsStream = null;
  }

  #acceptKeywordAudio(samples, sampleRate) {
    const stream = this.#kwsStream;
    if (!stream || this.#mode !== 'kws') return;
    stream.acceptWaveform({ samples, sampleRate });
    while (this.#kws.isReady(stream)) this.#kws.decode(stream);
    const keyword = this.#kws.getResult(stream).keyword;
    if (!keyword) return;
    this.#emit({ kind: 'wake', keyword, observedAt: new Date().toISOString() });
    void this.#playCue().catch(() => undefined);
    const requestId = crypto.randomUUID();
    void this.startRecognition({ requestId, source: 'background-wake' });
  }

  #acceptRecognitionAudio(samples, sampleRate) {
    const stream = this.#recognizerStream;
    if (!stream || this.#mode !== 'stt') return;
    stream.acceptWaveform({ samples, sampleRate });
    while (this.#recognizer.isReady(stream)) this.#recognizer.decode(stream);
    const text = this.#recognizer.getResult(stream).text.trim();
    if (text && text !== this.#lastPartial) {
      this.#lastPartial = text;
      this.#emit({ kind: 'transcript.partial', requestId: this.#request.requestId, text });
    }
    this.#vadBuffer.push(samples);
    while (this.#vadBuffer.size() >= 512) {
      const window = this.#vadBuffer.get(this.#vadBuffer.head(), 512);
      this.#vadBuffer.pop(512);
      this.#vad.acceptWaveform(window);
      if (!this.#vad.isEmpty()) {
        this.#vad.pop();
        this.#finishRecognition();
        return;
      }
    }
  }

  #finishRecognition() {
    const stream = this.#recognizerStream;
    const request = this.#request;
    if (!stream || !request) return;
    stream.inputFinished();
    while (this.#recognizer.isReady(stream)) this.#recognizer.decode(stream);
    const text = this.#recognizer.getResult(stream).text.trim() || this.#lastPartial;
    this.#request = null;
    this.#recognizerStream = null;
    this.#stopInput();
    this.#mode = 'idle';
    if (text) this.#emit({ kind: 'transcript.final', requestId: request.requestId, text, source: request.source });
    this.#reconcileKeywordListening();
    this.#emitStatus();
  }

  async #createTts(payload) {
    if (!this.#sherpa) throw new Error('sherpa_onnx_unavailable');
    const { root, manifest } = payload;
    const files = manifest.files;
    return this.#sherpa.OfflineTts.createAsync({
      model: {
        vits: {
          model: resolve(root, files.model),
          tokens: resolve(root, files.tokens),
          ...(files.lexicon ? { lexicon: resolve(root, files.lexicon) } : {}),
          ...(files.dataDir ? { dataDir: resolve(root, files.dataDir) } : {})
        },
        debug: false,
        numThreads: 2,
        provider: 'cpu'
      },
      maxNumSentences: 1,
      ...(files.ruleFsts?.length ? { ruleFsts: files.ruleFsts.map((path) => resolve(root, path)).join(',') } : {})
    });
  }

  #play(samples, sampleRate, cancellation) {
    return new Promise((resolvePromise, reject) => {
      if (cancellation !== this.#ttsCancellation) return resolvePromise();
      try {
        const device = this.#selectDevice(false);
        const configs = this.#cpal.getSupportedOutputConfigs(device.deviceId).filter((item) => item.format === 'f32');
        const selected = configs.find((item) => item.channels === 1 && sampleRate >= item.minSampleRate && sampleRate <= item.maxSampleRate)
          ?? configs.find((item) => sampleRate >= item.minSampleRate && sampleRate <= item.maxSampleRate)
          ?? configs[0];
        if (!selected) throw new Error('output_f32_unsupported');
        const outputRate = Math.max(selected.minSampleRate, Math.min(selected.maxSampleRate, sampleRate));
        const mono = outputRate === sampleRate
          ? samples
          : new this.#sherpa.LinearResampler(sampleRate, outputRate).resample(samples);
        const outputSamples = selected.channels === 1 ? mono : interleaveMono(mono, selected.channels);
        const stream = this.#cpal.createStream(device.deviceId, false, {
          sampleRate: outputRate,
          channels: selected.channels,
          format: 'f32'
        }, () => {});
        this.#cpal.writeToStream(stream, outputSamples);
        const timer = setTimeout(() => {
          if (this.#output?.stream === stream) this.#output = null;
          this.#cpal.closeStream(stream);
          resolvePromise();
        }, Math.ceil(outputSamples.length / selected.channels / outputRate * 1000) + 100);
        this.#output = { stream, timer, resolve: resolvePromise };
      } catch (error) {
        reject(error);
      }
    });
  }

  #playCue() {
    const sampleRate = 16000;
    const samples = new Float32Array(Math.floor(sampleRate * 0.09));
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(2 * Math.PI * 880 * i / sampleRate) * 0.16;
    return this.#play(samples, sampleRate, this.#ttsCancellation);
  }

  #emitStatus() {
    this.#emit({ kind: 'status', status: { protocolVersion: 1, moduleRoot: this.#root, voices: [], ...this.status() } });
  }

  #selectDevice(input) {
    const configured = input ? this.#config?.inputDeviceId : this.#config?.outputDeviceId;
    if (configured && configured !== 'default') {
      const match = this.#cpal.getDevices().find((device) => device.deviceId === configured);
      if (match) return match;
    }
    return input ? this.#cpal.getDefaultInputDevice() : this.#cpal.getDefaultOutputDevice();
  }

  #audioDevices(input) {
    if (!this.#cpal) return [];
    try {
      return this.#cpal.getDevices()
        .filter((device) => input ? device.isDefaultInput || supports(this.#cpal, device.deviceId, true) : device.isDefaultOutput || supports(this.#cpal, device.deviceId, false))
        .map((device) => ({
          id: device.deviceId,
          label: device.name,
          isDefault: input ? device.isDefaultInput : device.isDefaultOutput
        }));
    } catch {
      return [];
    }
  }
}

function interleaveMono(samples, channels) {
  const output = new Float32Array(samples.length * channels);
  for (let index = 0; index < samples.length; index += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      output[index * channels + channel] = samples[index];
    }
  }
  return output;
}

function activityForMode(mode) {
  return { idle: 'idle', kws: 'listening', stt: 'transcribing', tts: 'speaking' }[mode] ?? 'error';
}

function supports(cpal, deviceId, input) {
  try {
    const configs = input ? cpal.getSupportedInputConfigs(deviceId) : cpal.getSupportedOutputConfigs(deviceId);
    return configs.some((config) => config.format === 'f32');
  } catch {
    return false;
  }
}

function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/u, ''));
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.slice(0, 500))));
  });
}
