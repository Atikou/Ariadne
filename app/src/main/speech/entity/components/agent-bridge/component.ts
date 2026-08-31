import { defineComponent } from '@ariadne/component-contracts';
import { SPEECH_COMPONENT_IDS } from '../../speech-component-ids';

export default defineComponent({ id: SPEECH_COMPONENT_IDS.agentBridge, version: '1.0.0', entity: 'speech', dependsOn: [SPEECH_COMPONENT_IDS.rendererBridge] });
