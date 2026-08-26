/** @deprecated Legacy facade; v3 production ownership is the observability adapter. */
export {
  TelemetryService,
  sanitizeTelemetryAttributes,
  type LifecycleTelemetryRecord,
  type ProviderTelemetryRecord
} from '../adapters/observability/ProductionTelemetryService.js';
