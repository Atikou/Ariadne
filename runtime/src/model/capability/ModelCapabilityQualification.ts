export const MODEL_CAPABILITY_ADAPTER_PROTOCOL_VERSION = 1 as const;

export type QualificationState = 'unknown' | 'testing' | 'qualified' | 'rejected';

export interface ModelCapabilityQualification {
  readonly modelId: string;
  readonly providerId: string;
  readonly fingerprint: string;
  readonly adapterProtocolVersion: number;
  readonly textResponse: QualificationState;
  readonly streamingText: QualificationState;
  readonly exactTokenizer: QualificationState;
  readonly cancellation: QualificationState;
  readonly visionInput: QualificationState;
  readonly nativeToolCalls: QualificationState;
  readonly validToolArguments: QualificationState;
  readonly toolSelection: QualificationState;
  readonly toolResultContinuation: QualificationState;
  readonly directTextInAgent: QualificationState;
  readonly ariadneControlCalls: QualificationState;
  readonly planControlCalls: QualificationState;
  readonly testedAt?: string;
  readonly evidenceDigest?: string;
  readonly failureCode?: string;
}

export interface DerivedModelCapabilities {
  readonly supportsTextChat: boolean;
  readonly supportsAgent: boolean;
  readonly supportsPlan: boolean;
  readonly supportsVision: boolean;
  readonly qualificationState: QualificationState;
}

export function unknownQualification(input: {
  readonly modelId: string;
  readonly providerId: string;
  readonly fingerprint: string;
}): ModelCapabilityQualification {
  return Object.freeze({
    ...input,
    adapterProtocolVersion: MODEL_CAPABILITY_ADAPTER_PROTOCOL_VERSION,
    textResponse: 'unknown',
    streamingText: 'unknown',
    exactTokenizer: 'unknown',
    cancellation: 'unknown',
    visionInput: 'unknown',
    nativeToolCalls: 'unknown',
    validToolArguments: 'unknown',
    toolSelection: 'unknown',
    toolResultContinuation: 'unknown',
    directTextInAgent: 'unknown',
    ariadneControlCalls: 'unknown',
    planControlCalls: 'unknown'
  });
}

export function deriveModelCapabilities(
  report: ModelCapabilityQualification
): DerivedModelCapabilities {
  const supportsTextChat = report.textResponse === 'qualified';
  const supportsAgent = supportsTextChat
    && report.nativeToolCalls === 'qualified'
    && report.validToolArguments === 'qualified'
    && report.toolSelection === 'qualified'
    && report.toolResultContinuation === 'qualified'
    && report.directTextInAgent === 'qualified'
    && report.ariadneControlCalls === 'qualified';
  const supportsPlan = supportsAgent && report.planControlCalls === 'qualified';
  const qualificationState = report.textResponse === 'testing'
    ? 'testing'
    : report.textResponse === 'qualified'
      ? 'qualified'
      : report.textResponse === 'rejected'
        ? 'rejected'
        : 'unknown';
  return Object.freeze({
    supportsTextChat,
    supportsAgent,
    supportsPlan,
    supportsVision: report.visionInput === 'qualified',
    qualificationState
  });
}

export function assertQualificationReport(
  report: ModelCapabilityQualification
): ModelCapabilityQualification {
  if (
    report.adapterProtocolVersion !== MODEL_CAPABILITY_ADAPTER_PROTOCOL_VERSION
    || !report.modelId.trim()
    || !report.providerId.trim()
    || !/^sha256:[a-f0-9]{64}$/u.test(report.fingerprint)
  ) throw new Error('model_capability_report_invalid');
  const states = [
    report.textResponse,
    report.streamingText,
    report.exactTokenizer,
    report.cancellation,
    report.visionInput,
    report.nativeToolCalls,
    report.validToolArguments,
    report.toolSelection,
    report.toolResultContinuation,
    report.directTextInAgent,
    report.ariadneControlCalls,
    report.planControlCalls
  ];
  if (states.some((state) => !QUALIFICATION_STATES.has(state))) {
    throw new Error('model_capability_report_invalid');
  }
  if (report.testedAt !== undefined && new Date(report.testedAt).toISOString() !== report.testedAt) {
    throw new Error('model_capability_report_invalid');
  }
  if (report.evidenceDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(report.evidenceDigest)) {
    throw new Error('model_capability_report_invalid');
  }
  if (report.failureCode !== undefined && !/^[a-z0-9_]{1,128}$/u.test(report.failureCode)) {
    throw new Error('model_capability_report_invalid');
  }
  return report;
}

const QUALIFICATION_STATES = new Set<QualificationState>([
  'unknown',
  'testing',
  'qualified',
  'rejected'
]);
