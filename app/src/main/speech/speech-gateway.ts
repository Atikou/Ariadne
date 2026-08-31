import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type {
  ActivateSpeechVoiceRequest,
  CancelSpeechSynthesisRequest,
  SpeechEvent,
  SpeechPreferences,
  SpeechStatus,
  SpeechSynthesisSegmentRequest,
  SpeechVoiceSummary,
  StartSpeechRecognitionRequest,
  StopSpeechRecognitionRequest,
  VoicePackInstallResult
} from '@shared/contract';
import { FramedJsonDecoder, writeFramedJson } from './framed-json';
import { VoicePackManager, type VoicePackManifest } from './voice-pack-manager';
import type { SpeechPort } from './entity/speech-port';

const PROTOCOL_VERSION = 1 as const;
const REQUEST_TIMEOUT_MS = 15_000;

const responseSchema = z.object({
  type: z.literal('response'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional()
}).strict();

const sidecarEventSchema = z.object({
  type: z.literal('event'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  event: z.unknown()
}).strict();

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class SpeechGateway implements SpeechPort {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: FramedJsonDecoder | null = null;
  private preferences: SpeechPreferences | null = null;
  private voicePacks: VoicePackManager | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private background = false;
  private lockedOrSuspended = false;
  private status: SpeechStatus = unavailableStatus('E:\\AI\\AriadneSpeech', 'Speech preferences have not been loaded.');
  private operation: Promise<void> = Promise.resolve();

  async initialize(preferences: SpeechPreferences): Promise<void> {
    this.preferences = structuredClone(preferences);
    this.voicePacks = new VoicePackManager(preferences.moduleRoot);
    await this.reconcile();
  }

  getStatus(): SpeechStatus {
    return structuredClone(this.status);
  }

  onEvent(listener: (event: SpeechEvent) => void): () => void {
    this.events.on('speech', listener);
    return () => this.events.off('speech', listener);
  }

  async applyPreferences(previous: SpeechPreferences, next: SpeechPreferences): Promise<void> {
    this.preferences = structuredClone(next);
    if (previous.moduleRoot !== next.moduleRoot) this.voicePacks = new VoicePackManager(next.moduleRoot);
    await this.reconcile();
  }

  setBackground(background: boolean): void {
    this.background = background;
    void this.sendConfiguration();
  }

  setLockedOrSuspended(value: boolean): void {
    this.lockedOrSuspended = value;
    void this.sendConfiguration();
  }

  async startRecognition(request: StartSpeechRecognitionRequest): Promise<void> {
    await this.request('recognition.start', request);
  }

  async stopRecognition(request: StopSpeechRecognitionRequest): Promise<void> {
    await this.request('recognition.stop', request);
  }

  async cancelRecognition(): Promise<void> {
    await this.request('recognition.cancel', {});
  }

  async synthesize(request: SpeechSynthesisSegmentRequest): Promise<void> {
    await this.request('tts.synthesize', request, 60_000);
  }

  async cancelSynthesis(request: CancelSpeechSynthesisRequest = {}): Promise<void> {
    await this.request('tts.cancel', request);
  }

  async installVoicePack(archivePath: string): Promise<VoicePackInstallResult> {
    if (!this.voicePacks) throw new Error('speech_gateway_not_initialized');
    const result = await this.voicePacks.install(archivePath, async (root, manifest) => {
      await this.request('voice.test', voiceLoadPayload(root, manifest), 60_000);
    });
    await this.refreshStatus();
    return result;
  }

  async activateVoice(request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary> {
    if (!this.voicePacks) throw new Error('speech_gateway_not_initialized');
    const candidate = await this.voicePacks.resolveVoice(request.voiceId, request.version);
    await this.request('voice.load', voiceLoadPayload(candidate.root, candidate.manifest), 60_000);
    if (this.preferences) {
      this.preferences.activeVoiceId = request.voiceId;
      this.preferences.activeVoiceVersion = request.version;
    }
    await this.refreshStatus();
    const voice = this.status.voices.find((item) => item.voiceId === request.voiceId && item.version === request.version);
    if (!voice) throw new Error('speech_voice_activation_unconfirmed');
    return voice;
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => this.stopChild('app_dispose'));
  }

  private async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      const preferences = this.preferences;
      if (!preferences?.enabled) {
        await this.stopChild('disabled');
        this.updateStatus({ ...unavailableStatus(preferences?.moduleRoot ?? this.status.moduleRoot, 'Speech is disabled.'), availability: 'disabled' });
        return;
      }
      if (this.child) {
        await this.sendConfiguration();
        await this.refreshStatus();
        return;
      }
      await this.startChild(preferences.moduleRoot);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startChild(moduleRoot: string): Promise<void> {
    const launch = await resolveSidecarLaunch(moduleRoot);
    if (!launch) {
      this.updateStatus(unavailableStatus(moduleRoot, 'Speech Sidecar is not installed.'));
      return;
    }
    const child = spawn(launch.command, launch.args, {
      cwd: moduleRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    const decoder = new FramedJsonDecoder();
    this.decoder = decoder;
    child.stdout.on('data', (chunk: Buffer) => decoder.accept(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => console.info('[speech-sidecar]', chunk.trimEnd()));
    decoder.on('message', (message: unknown) => this.acceptMessage(message));
    decoder.on('error', (error: Error) => this.failChild(error));
    child.once('error', (error) => this.failChild(error));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.decoder = null;
      this.rejectPending(new Error('speech_sidecar_exited'));
      this.updateStatus(unavailableStatus(moduleRoot, `Speech Sidecar exited (${code ?? signal ?? 'unknown'}).`));
    });
    try {
      await this.request('hello', { protocolVersion: PROTOCOL_VERSION });
      await this.sendConfiguration();
      await this.refreshStatus();
    } catch (error) {
      await this.stopChild('handshake_failed');
      this.updateStatus(unavailableStatus(moduleRoot, `Speech Sidecar handshake failed: ${errorMessage(error)}`));
    }
  }

  private async stopChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { await this.request('shutdown', { reason }, 2_000); } catch { /* terminate below */ }
    if (this.child === child) {
      this.child = null;
      this.decoder = null;
      child.kill();
    }
    this.rejectPending(new Error('speech_sidecar_stopped'));
  }

  private async sendConfiguration(): Promise<void> {
    if (!this.child || !this.preferences) return;
    await this.request('configure', {
      moduleRoot: this.preferences.moduleRoot,
      inputDeviceId: this.preferences.inputDeviceId,
      outputDeviceId: this.preferences.outputDeviceId,
      backgroundWakeEnabled: this.preferences.backgroundWakeEnabled,
      wakeKeywords: this.preferences.wakeKeywords,
      background: this.background,
      listenAllowed: !this.lockedOrSuspended || this.preferences.listenWhenLocked,
      activeVoice: await this.resolveActiveVoicePayload()
    });
  }

  private async resolveActiveVoicePayload(): Promise<unknown | null> {
    if (!this.voicePacks || !this.preferences?.activeVoiceId || !this.preferences.activeVoiceVersion) return null;
    try {
      const voice = await this.voicePacks.resolveVoice(
        this.preferences.activeVoiceId,
        this.preferences.activeVoiceVersion
      );
      return voiceLoadPayload(voice.root, voice.manifest);
    } catch {
      return null;
    }
  }

  private async refreshStatus(): Promise<void> {
    if (!this.preferences) return;
    const result = await this.request('status.get', {});
    const parsed = z.object({
      availability: z.enum(['available', 'degraded', 'unavailable']),
      activity: z.enum(['idle', 'waking', 'listening', 'transcribing', 'speaking', 'error']),
      detail: z.string(),
      capabilities: z.array(z.enum(['stt', 'tts', 'kws', 'voice-pack'])),
      inputDevices: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() }).strict()),
      outputDevices: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() }).strict())
    }).strict().parse(result);
    const voices = await this.voicePacks?.list(
      this.preferences.activeVoiceId,
      this.preferences.activeVoiceVersion
    ) ?? [];
    this.updateStatus({ protocolVersion: PROTOCOL_VERSION, moduleRoot: this.preferences.moduleRoot, voices, ...parsed });
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('speech_unavailable'));
    const requestId = `speech-${process.pid}-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`speech_request_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { timer, resolve, reject });
      void writeFramedJson(child.stdin, {
        type: 'request',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        method,
        params
      }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private acceptMessage(input: unknown): void {
    const response = responseSchema.safeParse(input);
    if (response.success) {
      const pending = this.pending.get(response.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.data.requestId);
      if (response.data.ok) pending.resolve(response.data.result);
      else pending.reject(new Error(response.data.error ?? 'speech_request_failed'));
      return;
    }
    const event = sidecarEventSchema.safeParse(input);
    if (!event.success) {
      this.failChild(new Error('speech_protocol_message_invalid'));
      return;
    }
    const parsedEvent = parseSpeechEvent(event.data.event);
    if (parsedEvent.kind === 'status') this.status = parsedEvent.status;
    this.events.emit('speech', parsedEvent);
  }

  private failChild(error: Error): void {
    console.error('Speech Sidecar protocol failed.', error);
    const root = this.preferences?.moduleRoot ?? this.status.moduleRoot;
    const child = this.child;
    this.child = null;
    this.decoder = null;
    child?.kill();
    this.rejectPending(error);
    this.updateStatus(unavailableStatus(root, error.message));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private updateStatus(status: SpeechStatus): void {
    this.status = structuredClone(status);
    this.events.emit('speech', { kind: 'status', status: this.getStatus() } satisfies SpeechEvent);
  }
}

async function resolveSidecarLaunch(moduleRoot: string): Promise<{ command: string; args: string[] } | null> {
  const override = process.env.ARIADNE_SPEECH_SIDECAR;
  if (override && isAbsolute(override) && await exists(override)) return { command: override, args: ['--module-root', moduleRoot] };
  const node = join(moduleRoot, 'runtime', 'node.exe');
  const script = join(moduleRoot, 'runtime', 'dist', 'sidecar.mjs');
  if (await exists(node) && await exists(script)) return { command: node, args: [script, '--module-root', moduleRoot] };
  return null;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function unavailableStatus(moduleRoot: string, detail: string): SpeechStatus {
  return {
    protocolVersion: PROTOCOL_VERSION,
    availability: 'unavailable',
    activity: 'idle',
    detail,
    moduleRoot,
    capabilities: [],
    inputDevices: [],
    outputDevices: [],
    voices: []
  };
}

function voiceLoadPayload(root: string, manifest: VoicePackManifest): unknown {
  return { root, manifest };
}

function parseSpeechEvent(input: unknown): SpeechEvent {
  const statusSchema = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    availability: z.enum(['available', 'degraded', 'disabled', 'unavailable']),
    activity: z.enum(['idle', 'waking', 'listening', 'transcribing', 'speaking', 'error']),
    detail: z.string(),
    moduleRoot: z.string(),
    capabilities: z.array(z.enum(['stt', 'tts', 'kws', 'voice-pack'])),
    inputDevices: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() }).strict()),
    outputDevices: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() }).strict()),
    voices: z.array(z.object({
      voiceId: z.string(),
      version: z.string(),
      displayName: z.string(),
      languages: z.array(z.string()),
      sampleRate: z.number().int().positive(),
      active: z.boolean()
    }).strict())
  }).strict();
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('status'), status: statusSchema }).strict(),
    z.object({ kind: z.literal('wake'), keyword: z.string(), observedAt: z.string().datetime() }).strict(),
    z.object({ kind: z.literal('transcript.partial'), requestId: z.string(), text: z.string() }).strict(),
    z.object({ kind: z.literal('transcript.final'), requestId: z.string(), text: z.string(), source: z.enum(['foreground', 'background-wake']) }).strict(),
    z.object({ kind: z.literal('tts.started'), turnId: z.string() }).strict(),
    z.object({ kind: z.literal('tts.segment-completed'), turnId: z.string(), sequence: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('tts.completed'), turnId: z.string() }).strict(),
    z.object({ kind: z.literal('tts.cancelled'), turnId: z.string().nullable() }).strict(),
    z.object({ kind: z.literal('error'), operation: z.string(), message: z.string(), retryable: z.boolean() }).strict()
  ]).parse(input) as SpeechEvent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
