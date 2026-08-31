import type { PublicRunProjectionV3, RuntimeStatus } from '@ariadne/protocol/public';

export interface RunFeatureHost {
  hasCapability(capability: RuntimeStatus['capabilities'][number]): boolean;
  projectionRuns(): readonly PublicRunProjectionV3[];
  isLifecycleGenerationCurrent(generation: number): boolean;
  errorMessage(error: unknown, fallback?: string): string;
  publish(): void;
  synchronize(): Promise<void>;
}
