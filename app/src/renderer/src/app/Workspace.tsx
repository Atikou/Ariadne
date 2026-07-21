import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  DockviewReact,
  themeAbyss,
  type AddPanelOptions,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type SerializedDockview
} from 'dockview-react';
import type { JsonObject } from '@shared/contract';
import type { FeatureModuleDefinition, ModuleServices, ModuleId } from '@renderer/core/modules/module-contract';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import { ModuleTab } from './ModuleTab';

const ariadneDockviewTheme: DockviewTheme = {
  ...themeAbyss,
  name: 'ariadne',
  className: 'dockview-theme-abyss ariadne-dockview-theme',
  gap: 6,
  edgeGroupCollapsedSize: 44
};

const EDGE_POSITIONS = ['top', 'right', 'bottom', 'left'] as const;
const LAYOUT_REVISION_KEY = '__ariadneLayoutRevision';
const LAYOUT_REVISION = 2;

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'error';

interface WorkspaceProps {
  registry: ModuleRegistry;
  services: ModuleServices;
  onApiReady(api: DockviewApi): void;
  onOpenModulesChanged(ids: ReadonlySet<string>): void;
  onSaveStatusChanged(status: SaveStatus): void;
}

export function Workspace({
  registry,
  services,
  onApiReady,
  onOpenModulesChanged,
  onSaveStatusChanged
}: WorkspaceProps): React.JSX.Element {
  const components = useMemo(() => registry.createDockviewComponents(services), [registry, services]);
  const saveTimer = useRef<number | null>(null);
  const restoring = useRef(true);
  const subscriptions = useRef<Array<{ dispose(): void }>>([]);

  useEffect(() => () => {
    for (const subscription of subscriptions.current) subscription.dispose();
    subscriptions.current = [];
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }, []);

  const syncOpenModules = useCallback((api: DockviewApi): void => {
    onOpenModulesChanged(new Set(registry.list().filter((module) => api.getPanel(module.id)).map((module) => module.id)));
  }, [onOpenModulesChanged, registry]);

  const saveLayout = useCallback((api: DockviewApi): void => {
    if (restoring.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    onSaveStatusChanged('saving');
    saveTimer.current = window.setTimeout(() => {
      const layout = serializeLayout(api);
      void window.ariadne.layout.save({ layout })
        .then(() => onSaveStatusChanged('saved'))
        .catch((error: unknown) => {
          console.error('Unable to save Dockview layout', error);
          onSaveStatusChanged('error');
        });
    }, 120);
  }, [onSaveStatusChanged]);

  const onReady = useCallback((event: DockviewReadyEvent): void => {
    const { api } = event;

    subscriptions.current.push(
      api.onDidAddPanel(() => syncOpenModules(api)),
      api.onDidRemovePanel(() => syncOpenModules(api)),
      api.onDidLayoutChange(() => saveLayout(api))
    );

    void restoreLayout(api, registry)
      .catch((error: unknown) => {
        console.error('Unable to restore Dockview layout', error);
        api.clear();
        addDefaultLayout(api, registry);
      })
      .finally(() => {
        restoring.current = false;
        syncOpenModules(api);
        onApiReady(api);
        onSaveStatusChanged('saved');
      });
  }, [onApiReady, onSaveStatusChanged, registry, saveLayout, syncOpenModules]);

  return (
    <DockviewReact
      className="ariadne-dockview"
      theme={ariadneDockviewTheme}
      components={components}
      tabComponents={{ moduleTab: ModuleTab }}
      onReady={onReady}
      disableFloatingGroups={false}
    />
  );
}

export function openModule(api: DockviewApi, registry: ModuleRegistry, id: ModuleId): void {
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    const edge = registry.get(id)?.defaultPlacement.edge;
    if (edge) api.getEdgeGroup(edge.position)?.expand();
    return;
  }

  const definition = registry.get(id);
  if (!definition) throw new Error(`Unknown module: ${id}`);
  addModulePanel(api, definition);
  if (definition.defaultPlacement.edge) api.getEdgeGroup(definition.defaultPlacement.edge.position)?.expand();
}

export function resetWorkspace(api: DockviewApi, registry: ModuleRegistry): void {
  for (const position of EDGE_POSITIONS) {
    if (api.getEdgeGroup(position)) api.removeEdgeGroup(position);
  }
  api.clear();
  addDefaultLayout(api, registry);
}

async function restoreLayout(api: DockviewApi, registry: ModuleRegistry): Promise<void> {
  const saved = await window.ariadne.layout.load();
  const layout = saved ? deserializeLayout(saved.layout) : null;
  if (!layout) {
    api.clear();
    addDefaultLayout(api, registry);
    return;
  }
  api.clear();
  api.fromJSON(layout);
}

function addDefaultLayout(api: DockviewApi, registry: ModuleRegistry): void {
  for (const definition of registry.list().filter((module) => module.defaultOpen)) addModulePanel(api, definition);
  api.getEdgeGroup('bottom')?.expand();
  api.getPanel(MODULE_IDS.toolOutput)?.api.setActive();
  api.getPanel(MODULE_IDS.agentStatus)?.api.setActive();
  api.getPanel(MODULE_IDS.chat)?.api.setActive();
}

function addModulePanel(api: DockviewApi, definition: FeatureModuleDefinition): void {
  const { defaultPlacement } = definition;
  const edge = defaultPlacement.edge;
  if (edge && !api.getEdgeGroup(edge.position)) {
    api.addEdgeGroup(edge.position, {
      id: edge.groupId,
      initialSize: edge.initialSize,
      collapsedSize: edge.collapsedSize,
      collapsed: edge.collapsed
    });
  }
  const position = edge
    ? { referenceGroup: edge.groupId }
    : defaultPlacement.referenceModuleId
    ? {
        referencePanel: defaultPlacement.referenceModuleId,
        ...(defaultPlacement.direction ? { direction: defaultPlacement.direction } : {})
      }
    : defaultPlacement.direction && defaultPlacement.direction !== 'within'
      ? { direction: defaultPlacement.direction }
      : undefined;

  const options: AddPanelOptions = {
    id: definition.id,
    component: definition.id,
    title: definition.name,
    tabComponent: 'moduleTab',
    params: { moduleId: definition.id, icon: definition.icon },
    renderer: 'always',
    ...(defaultPlacement.initialWidth ? { initialWidth: defaultPlacement.initialWidth } : {}),
    ...(defaultPlacement.initialHeight ? { initialHeight: defaultPlacement.initialHeight } : {}),
    ...(position ? { position } : {})
  };
  api.addPanel(options);
}

function toJsonObject(value: SerializedDockview): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function serializeLayout(api: DockviewApi): JsonObject {
  return {
    ...toJsonObject(api.toJSON()),
    [LAYOUT_REVISION_KEY]: LAYOUT_REVISION
  };
}

function deserializeLayout(value: JsonObject): SerializedDockview | null {
  if (value[LAYOUT_REVISION_KEY] !== LAYOUT_REVISION) return null;
  const { [LAYOUT_REVISION_KEY]: _revision, ...layout } = value;
  return layout as unknown as SerializedDockview;
}
