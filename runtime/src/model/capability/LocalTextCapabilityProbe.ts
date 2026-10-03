import { createHash } from 'node:crypto';

import type { ModelClient } from '../types.js';
import {
  unknownQualification,
  type ModelCapabilityQualification
} from './ModelCapabilityQualification.js';
import type { ModelCapabilityRegistry } from './ModelCapabilityRegistry.js';

const PROBE_PROMPT = '请只回复一段非空的自然语言文本，用一句话说明一加一等于几。';

/** Isolated model probe: no Conversation, Agent Run, workspace, or real Tool state exists here. */
export class LocalTextCapabilityProbe {
  public constructor(private readonly registry: ModelCapabilityRegistry) {}

  public async run(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly fingerprint: string;
    readonly client: ModelClient;
    readonly signal?: AbortSignal;
    readonly force?: boolean;
  }): Promise<ModelCapabilityQualification> {
    const prior = this.registry.read(input.providerId, input.modelId, input.fingerprint);
    if (
      input.force !== true
      && (prior.textResponse === 'qualified' || prior.textResponse === 'rejected')
    ) return prior;
    const identity = {
      providerId: input.providerId,
      modelId: input.modelId,
      fingerprint: input.fingerprint
    };
    const testing = {
      ...unknownQualification(identity),
      ...prior,
      textResponse: 'testing' as const,
      streamingText: 'testing' as const,
      exactTokenizer: 'testing' as const
    };
    this.registry.write(testing);
    const chunks: string[] = [];
    try {
      const response = await input.client.chat({
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [],
        temperature: 0,
        maxTokens: 64,
        signal: input.signal === undefined
          ? AbortSignal.timeout(120_000)
          : AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]),
        onToken: (chunk) => chunks.push(chunk)
      });
      const content = response.content.trim();
      const validText = content.length > 0 && response.toolCalls.length === 0;
      const counted = await input.client.tokenCounter.countText(PROBE_PROMPT);
      const report: ModelCapabilityQualification = {
        ...testing,
        textResponse: validText ? 'qualified' : 'rejected',
        streamingText: chunks.length > 0 && chunks.join('') === response.content
          ? 'qualified'
          : 'rejected',
        exactTokenizer: counted.exact ? 'qualified' : 'rejected',
        nativeToolCalls: input.client.toolCallCapability === 'native' ? prior.nativeToolCalls : 'rejected',
        validToolArguments: input.client.toolCallCapability === 'native' ? prior.validToolArguments : 'rejected',
        toolSelection: input.client.toolCallCapability === 'native' ? prior.toolSelection : 'rejected',
        toolResultContinuation: input.client.toolCallCapability === 'native'
          ? prior.toolResultContinuation : 'rejected',
        directTextInAgent: input.client.toolCallCapability === 'native'
          ? prior.directTextInAgent : 'rejected',
        ariadneControlCalls: input.client.toolCallCapability === 'native'
          ? prior.ariadneControlCalls : 'rejected',
        planControlCalls: input.client.toolCallCapability === 'native'
          ? prior.planControlCalls : 'rejected',
        testedAt: new Date().toISOString(),
        evidenceDigest: digestEvidence({
          validText,
          streamed: chunks.length > 0,
          streamMatches: chunks.join('') === response.content,
          tokenizerExact: counted.exact,
          nativeToolTransport: input.client.toolCallCapability
        }),
        ...(validText ? {} : { failureCode: 'model_response_empty' })
      };
      this.registry.write(report);
      return report;
    } catch (error) {
      const report: ModelCapabilityQualification = {
        ...testing,
        textResponse: 'rejected',
        testedAt: new Date().toISOString(),
        evidenceDigest: digestEvidence({ error: errorCode(error) }),
        failureCode: errorCode(error)
      };
      this.registry.write(report);
      return report;
    }
  }
}

function digestEvidence(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'model_probe_timeout';
  return 'model_probe_failed';
}
