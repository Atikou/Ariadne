import type { ServiceToken } from './service-token.js';

export type EntityKind = 'agent' | 'ui' | 'speech';

export interface ComponentServiceRequirement {
  readonly service: ServiceToken<unknown>;
  readonly optional: boolean;
}

export interface ComponentServiceProvision {
  readonly service: ServiceToken<unknown>;
  readonly optional: boolean;
}

export interface ComponentDefinition {
  readonly id: string;
  readonly version: string;
  readonly entity: EntityKind;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly consumes: readonly ComponentServiceRequirement[];
  readonly provides: readonly ComponentServiceProvision[];
  readonly configSchemaVersion: number;
}

export interface ComponentServiceScope {
  required<T>(service: ServiceToken<T>): T;
  optional<T>(service: ServiceToken<T>): T | undefined;
}

export interface ComponentServiceBinding<T = unknown> {
  readonly service: ServiceToken<T>;
  readonly value: T;
}

export interface ComponentHealth {
  readonly status: 'starting' | 'ready' | 'degraded' | 'unavailable' | 'stopped';
  readonly reason?: string;
}

export interface ComponentLifecycle<TShutdownContext> {
  health?(): ComponentHealth;
  prepareShutdown?(context: TShutdownContext): void | Promise<void>;
  close?(context: TShutdownContext): void | Promise<void>;
}

export interface ComponentHandle<TShutdownContext> extends ComponentLifecycle<TShutdownContext> {
  readonly services?: readonly ComponentServiceBinding[];
}

export interface ComponentDescriptor<TStartContext, THandle> {
  readonly definition: ComponentDefinition;
  start(
    context: TStartContext,
    services: ComponentServiceScope
  ): THandle | Promise<THandle>;
}

export interface ComponentKernelOptions {
  readonly errorNamespace?: string;
}
