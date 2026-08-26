import type { AriadneApi } from '@shared/contract';
import type { ModuleServices } from '../modules/module-contract';
import { createModuleServices } from './module-services';

const COMPOSITION_ROOT_KEY = '__ariadneRendererCompositionRootV1';

interface RendererCompositionRootGlobal {
  [COMPOSITION_ROOT_KEY]?: RendererCompositionRoot;
}

/**
 * Window-owned Renderer composition root. Feature panels consume its services,
 * but React mounts, Dockview restoration and hot updates never own or replace
 * the Runtime lifecycle.
 */
export class RendererCompositionRoot {
  readonly services: ModuleServices;
  private started = false;
  private disposed = false;
  private lifecycleInstalled = false;

  constructor(api: AriadneApi, storage: Storage) {
    this.services = createModuleServices(api, storage);
  }

  start(): Promise<void> {
    if (this.disposed) throw new Error('renderer_composition_root_disposed');
    this.started = true;
    return this.services.runtime.initialize();
  }

  installWindowLifecycle(target: Window): void {
    if (this.lifecycleInstalled) return;
    this.lifecycleInstalled = true;
    target.addEventListener('pagehide', () => this.dispose(), { once: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) this.services.runtime.dispose();
  }
}

export function getWindowRendererCompositionRoot(
  api: AriadneApi,
  storage: Storage,
  global: RendererCompositionRootGlobal = globalThis as RendererCompositionRootGlobal
): RendererCompositionRoot {
  const existing = global[COMPOSITION_ROOT_KEY];
  if (existing) return existing;
  const created = new RendererCompositionRoot(api, storage);
  global[COMPOSITION_ROOT_KEY] = created;
  return created;
}
