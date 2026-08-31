import {
  compileComponentDefinitionGraph,
  type ComponentDefinition
} from '@ariadne/component-contracts';
import type { SpeechStatus } from '@shared/contract';
import { SpeechGateway } from '../speech-gateway';
import { CapabilitySpeechAdapter, type SpeechCapability } from './capability-speech-adapter';
import {
  SPEECH_COMPONENT_DEFINITIONS,
  SPEECH_COMPONENT_IDS
} from './speech-components';
import type { SpeechPort } from './speech-port';
import { UnavailableSpeechAdapter } from './unavailable-speech-adapter';

export interface SpeechEntityManifest {
  readonly entity: 'speech';
  readonly components: readonly ComponentDefinition[];
  readonly capabilities: readonly SpeechCapability[];
}

export interface SpeechEntityHandle extends SpeechPort {
  readonly manifest: SpeechEntityManifest;
}

export function compileSpeechEntity(componentIds: readonly string[]): SpeechEntityHandle {
  const requested = new Set(componentIds);
  if (requested.size !== componentIds.length) throw new Error('speech_component_duplicate');
  const known = new Map(SPEECH_COMPONENT_DEFINITIONS.map((definition) => [definition.id, definition]));
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`speech_component_unknown:${id}`);
  }
  for (const definition of SPEECH_COMPONENT_DEFINITIONS) {
    if (definition.required && !requested.has(definition.id)) {
      throw new Error(`speech_required_component_missing:${definition.id}`);
    }
  }
  const ordered = compileComponentDefinitionGraph(
    'speech',
    componentIds.map((id) => known.get(id) as ComponentDefinition),
    { errorNamespace: 'speech_component' }
  );
  const capabilities = Object.freeze(capabilitiesFor(requested));
  const port: SpeechPort = requested.has(SPEECH_COMPONENT_IDS.sidecar)
    ? new CapabilitySpeechAdapter(new SpeechGateway(), capabilities)
    : new UnavailableSpeechAdapter();
  const manifest = Object.freeze({
    entity: 'speech' as const,
    components: ordered,
    capabilities
  });
  return Object.assign(port, { manifest });
}

function capabilitiesFor(ids: ReadonlySet<string>): SpeechStatus['capabilities'] {
  const capabilities: SpeechCapability[] = [];
  if (ids.has(SPEECH_COMPONENT_IDS.stt)) capabilities.push('stt');
  if (ids.has(SPEECH_COMPONENT_IDS.tts)) capabilities.push('tts');
  if (ids.has(SPEECH_COMPONENT_IDS.kws)) capabilities.push('kws');
  if (ids.has(SPEECH_COMPONENT_IDS.voicePack)) capabilities.push('voice-pack');
  return capabilities;
}
