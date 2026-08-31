import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type FunctionComponent,
  type ReactNode
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ModuleServices, FeatureModuleDefinition, ModuleId } from './module-contract';

export interface ModuleNavigationAction {
  readonly id: string;
  readonly label: string;
  readonly icon: FeatureModuleDefinition['icon'];
  readonly order: number;
  readonly position: 'primary' | 'footer';
  readonly moduleIds: readonly ModuleId[];
}

export class ModuleRegistry {
  private readonly definitions = new Map<ModuleId, FeatureModuleDefinition>();

  constructor(modules: readonly FeatureModuleDefinition[]) {
    for (const definition of modules) {
      if (this.definitions.has(definition.id)) throw new Error(`Duplicate module id: ${definition.id}`);
      this.definitions.set(definition.id, definition);
    }

    for (const definition of modules) {
      const reference = definition.defaultPlacement.referenceModuleId;
      if (reference && !this.definitions.has(reference)) {
        throw new Error(`Module ${definition.id} references unknown module ${reference}`);
      }
    }
  }

  list(): readonly FeatureModuleDefinition[] {
    return [...this.definitions.values()];
  }

  get(id: string): FeatureModuleDefinition | undefined {
    return this.definitions.get(id as ModuleId);
  }

  navigationActions(): readonly ModuleNavigationAction[] {
    const actions = new Map<string, ModuleNavigationAction>();
    for (const definition of this.list()) {
      const contribution = definition.navigation;
      if (contribution === undefined) continue;
      const existing = actions.get(contribution.id);
      if (existing === undefined) {
        actions.set(contribution.id, Object.freeze({
          ...contribution,
          moduleIds: Object.freeze([definition.id])
        }));
        continue;
      }
      if (
        existing.label !== contribution.label
        || existing.icon !== contribution.icon
        || existing.order !== contribution.order
        || existing.position !== contribution.position
      ) throw new Error(`Module navigation contribution conflict: ${contribution.id}`);
      actions.set(contribution.id, Object.freeze({
        ...existing,
        moduleIds: Object.freeze([...existing.moduleIds, definition.id])
      }));
    }
    return Object.freeze([...actions.values()].sort((left, right) => (
      left.order - right.order || left.id.localeCompare(right.id)
    )));
  }

  createDockviewComponents(services: ModuleServices): Record<string, FunctionComponent<IDockviewPanelProps>> {
    return Object.fromEntries(
      this.list().map((definition) => [definition.id, createPanelAdapter(definition, services)])
    );
  }
}

function createPanelAdapter(
  definition: FeatureModuleDefinition,
  services: ModuleServices
): FunctionComponent<IDockviewPanelProps> {
  const FeaturePanel = definition.component;

  return function ModulePanelAdapter({ api, containerApi }) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let frame = 0;

      const syncOverlayCorners = (): void => {
        const overlay = hostRef.current?.closest<HTMLElement>('.dv-render-overlay');
        if (!overlay) return;
        overlay.dataset.ariadneHeaderPosition = api.group.api.getHeaderPosition();
      };

      syncOverlayCorners();
      frame = window.requestAnimationFrame(syncOverlayCorners);
      const groupSubscription = api.onDidGroupChange(syncOverlayCorners);
      const layoutSubscription = containerApi.onDidLayoutChange(syncOverlayCorners);

      return () => {
        window.cancelAnimationFrame(frame);
        groupSubscription.dispose();
        layoutSubscription.dispose();
        const overlay = hostRef.current?.closest<HTMLElement>('.dv-render-overlay');
        if (overlay) delete overlay.dataset.ariadneHeaderPosition;
      };
    }, [api, containerApi]);

    useEffect(() => {
      const context = { moduleId: definition.id, services };
      let disposed = false;
      let created = false;
      let isActive = false;
      let activeSubscription: { dispose(): void } | undefined;

      void Promise.resolve(definition.lifecycle?.onCreate?.(context))
        .then(() => {
          created = true;
          if (disposed) {
            definition.lifecycle?.onDispose?.(context);
            return;
          }

          isActive = api.isActive;
          if (isActive) definition.lifecycle?.onActivate?.(context);
          activeSubscription = api.onDidActiveChange((event) => {
            isActive = event.isActive;
            if (event.isActive) definition.lifecycle?.onActivate?.(context);
            else definition.lifecycle?.onDeactivate?.(context);
          });
        })
        .catch((error: unknown) => console.error(`Module ${definition.id} failed to initialize`, error));

      return () => {
        disposed = true;
        activeSubscription?.dispose();
        if (created) {
          if (isActive) definition.lifecycle?.onDeactivate?.(context);
          definition.lifecycle?.onDispose?.(context);
        }
      };
    }, [api]);

    return (
      <div ref={hostRef} className="module-panel-host">
        <ModulePanelErrorBoundary moduleId={definition.id} moduleName={definition.name}>
          <FeaturePanel moduleId={definition.id} services={services} />
        </ModulePanelErrorBoundary>
      </div>
    );
  };
}

interface ModulePanelErrorBoundaryProps {
  moduleId: ModuleId;
  moduleName: string;
  children: ReactNode;
}

interface ModulePanelErrorBoundaryState {
  error: Error | null;
}

class ModulePanelErrorBoundary extends Component<
  ModulePanelErrorBoundaryProps,
  ModulePanelErrorBoundaryState
> {
  state: ModulePanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ModulePanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Module ${this.props.moduleId} failed to render`, error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section className="module-panel-error" role="alert">
        <h2>{this.props.moduleName}暂时无法显示</h2>
        <p>该模块发生了界面错误，Ariadne 其他功能仍可继续使用。</p>
        <button type="button" onClick={() => this.setState({ error: null })}>重试</button>
      </section>
    );
  }
}
