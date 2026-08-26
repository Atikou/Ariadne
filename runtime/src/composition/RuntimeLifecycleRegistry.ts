import type { ShutdownContext } from '../ingress/ShutdownContext.js';

export interface RuntimeInitializationResource {
  readonly name: string;
  readonly close: (context: ShutdownContext) => void | Promise<void>;
}

/**
 * Tracks only resources acquired during bootstrap. If bootstrap fails, every
 * acquired resource is closed in strict reverse order. Normal Runtime shutdown
 * remains an explicit protocol because producer freeze and owner-fence order
 * are stronger requirements than generic stack disposal.
 */
export class RuntimeLifecycleRegistry {
  private readonly resources: RuntimeInitializationResource[] = [];
  private committed = false;

  public register(resource: RuntimeInitializationResource): void {
    if (this.committed) throw new Error('runtime_lifecycle_registry_committed');
    this.resources.push(resource);
  }

  public commit(): void {
    this.committed = true;
    this.resources.length = 0;
  }

  public async rollback(context: ShutdownContext): Promise<readonly unknown[]> {
    if (this.committed) throw new Error('runtime_lifecycle_registry_committed');
    const failures: unknown[] = [];
    while (this.resources.length > 0) {
      const resource = this.resources.pop();
      if (!resource) continue;
      try {
        await resource.close(context);
      } catch (error) {
        failures.push(new Error(
          `runtime_initialization_cleanup_failed:${resource.name}`,
          { cause: error }
        ));
      }
    }
    return failures;
  }
}
