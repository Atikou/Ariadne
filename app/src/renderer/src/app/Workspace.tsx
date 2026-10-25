import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
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
import { DOCKVIEW_POPOUT_PATH } from '@shared/windowing';
import type { FeatureModuleDefinition, ModuleServices, ModuleId } from '@renderer/core/modules/module-contract';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import { ModuleTab } from './ModuleTab';
import { WorkspaceGroupActions } from './WorkspaceGroupActions';
import { isScreenPointOutsideWindow, type ScreenPoint } from './module-popout-policy';
import { applyThemeToWindow, type EffectiveTheme } from './theme-sync';

const ariadneDockviewTheme: DockviewTheme = {
  ...themeAbyss,
  name: 'ariadne',
  // Dockview propagates one standard theme class into popout windows.
  // App styles extend that same class, including tab geometry and colors.
  className: themeAbyss.className,
  gap: 6,
  edgeGroupCollapsedSize: 44
};

const EDGE_POSITIONS = ['top', 'right', 'bottom', 'left'] as const;
const LAYOUT_REVISION_KEY = '__ariadneLayoutRevision';
const LAYOUT_REVISION = 3;

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'error';

interface WorkspaceProps {
  registry: ModuleRegistry;
  services: ModuleServices;
  onApiReady(api: DockviewApi): void;
  onOpenModulesChanged(ids: ReadonlySet<string>): void;
  onSaveStatusChanged(status: SaveStatus): void;
  effectiveTheme: EffectiveTheme;
}

export function Workspace({
  registry,
  services,
  onApiReady,
  onOpenModulesChanged,
  onSaveStatusChanged,
  effectiveTheme
}: WorkspaceProps): React.JSX.Element {
  const components = useMemo(() => registry.createDockviewComponents(services), [registry, services]);
  const saveTimer = useRef<number | null>(null);
  const restoring = useRef(true);
  const subscriptions = useRef<Array<{ dispose(): void }>>([]);
  const apiRef = useRef<DockviewApi | null>(null);
  const dragPoint = useRef<ScreenPoint | null>(null);
  const effectiveThemeRef = useRef(effectiveTheme);
  effectiveThemeRef.current = effectiveTheme;

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const popout of api.getPopouts()) applyThemeToWindow(popout.window, effectiveTheme);
  }, [effectiveTheme]);

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
    apiRef.current = api;

    subscriptions.current.push(
      api.onDidAddPanel(() => syncOpenModules(api)),
      api.onDidRemovePanel(() => syncOpenModules(api)),
      api.onDidLayoutChange(() => saveLayout(api)),
      api.onDidAddPopoutGroup((popout) => applyThemeToWindow(popout.window, effectiveThemeRef.current))
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

  const rememberDragPosition = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.screenX !== 0 || event.screenY !== 0) {
      dragPoint.current = { x: event.screenX, y: event.screenY };
    }
  };

  const popoutWhenDroppedOutside = (event: ReactDragEvent<HTMLDivElement>): void => {
    const moduleId = getDraggedModuleId(event.target);
    const point = event.screenX !== 0 || event.screenY !== 0
      ? { x: event.screenX, y: event.screenY }
      : dragPoint.current;
    dragPoint.current = null;
    if (!moduleId || !point) return;
    const outside = isScreenPointOutsideWindow(point, {
      left: window.screenX,
      top: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight
    });
    if (!outside) return;

    window.setTimeout(() => {
      const api = apiRef.current;
      const panel = api?.getPanel(moduleId);
      if (!api || !panel || panel.api.location.type === 'popout') return;
      void api.addPopoutGroup(panel).catch((error: unknown) => {
        console.error('Unable to open module in a separate window', error);
      });
    }, 0);
  };

  return (
    <div
      className="ariadne-dockview-host"
      onDrag={rememberDragPosition}
      onDragEnd={popoutWhenDroppedOutside}
    >
      <DockviewReact
        className="ariadne-dockview"
        theme={ariadneDockviewTheme}
        components={components}
        tabComponents={{ moduleTab: ModuleTab }}
        rightHeaderActionsComponent={WorkspaceGroupActions}
        disableTabsOverflowList
        onReady={onReady}
        disableFloatingGroups={false}
        popoutUrl={DOCKVIEW_POPOUT_PATH}
      />
    </div>
  );
}

function getDraggedModuleId(target: EventTarget): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.dv-tab')?.querySelector<HTMLElement>('.module-tab')?.dataset.moduleId ?? null;
}

export function openModule(api: DockviewApi, registry: ModuleRegistry, id: ModuleId): void {
  const existing = api.getPanel(id);
  if (api.hasMaximizedGroup() && !existing?.api.isMaximized()) api.exitMaximizedGroup();
  if (existing) {
    existing.api.setActive();
    const edge = registry.get(id)?.defaultPlacement.edge;
    if (edge) api.getEdgeGroup(edge.position)?.expand();
    revealModule(api, id);
    return;
  }

  const definition = registry.get(id);
  if (!definition) throw new Error(`Unknown module: ${id}`);
  addModulePanel(api, definition);
  if (definition.defaultPlacement.edge) api.getEdgeGroup(definition.defaultPlacement.edge.position)?.expand();
  revealModule(api, id);
}

/** Explicit navigation must reveal a grid panel even when other groups' minimum widths overflow. */
function revealModule(api: DockviewApi, id: ModuleId): void {
  const panel = api.getPanel(id);
  if (!panel || panel.api.location.type !== 'grid') return;
  const element = panel.group.element;
  const host = element.closest('.ariadne-dockview-host');
  if (!host) return;
  const bounds = element.getBoundingClientRect(), viewport = host.getBoundingClientRect();
  if (bounds.left < viewport.left - 1 || bounds.right > viewport.right + 1
    || bounds.top < viewport.top - 1 || bounds.bottom > viewport.bottom + 1) panel.api.maximize();
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
  api.fromJSON(withModuleConstraints(layout, registry));
}

function addDefaultLayout(api: DockviewApi, registry: ModuleRegistry): void {
  const pending = new Map(registry.list()
    .filter((module) => module.defaultOpen)
    .map((definition) => [definition.id, definition]));
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((definition) => {
      const reference = definition.defaultPlacement.referenceModuleId;
      return reference === undefined || api.getPanel(reference) !== undefined;
    });
    if (ready.length === 0) {
      throw new Error(`ui_default_layout_dependency_unresolved:${[...pending.keys()].sort().join(',')}`);
    }
    for (const definition of ready) {
      addModulePanel(api, definition);
      pending.delete(definition.id);
    }
  }
  api.getEdgeGroup('bottom')?.expand();
  for (const definition of registry.list()
    .filter((module) => module.defaultOpen && module.defaultActivationOrder !== undefined)
    .sort((left, right) => (
      (left.defaultActivationOrder ?? 0) - (right.defaultActivationOrder ?? 0)
    ))) {
    api.getPanel(definition.id)?.api.setActive();
  }
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
    minimumWidth: definition.layoutConstraints.minimumWidth,
    ...(defaultPlacement.initialWidth ? { initialWidth: defaultPlacement.initialWidth } : {}),
    ...(defaultPlacement.initialHeight ? { initialHeight: defaultPlacement.initialHeight } : {}),
    ...(position ? { position } : {})
  };
  api.addPanel(options);
}

function withModuleConstraints(layout: SerializedDockview, registry: ModuleRegistry): SerializedDockview {
  // Dockview panel constraints are constructor state; its panel API setter
  // does not update them. Supply current definitions when rebuilding panels.
  const panels = Object.fromEntries(Object.entries(layout.panels).map(([id, panel]) => {
    const definition = panel.contentComponent ? registry.get(panel.contentComponent) : undefined;
    return [id, definition ? { ...panel, minimumWidth: definition.layoutConstraints.minimumWidth } : panel];
  }));
  return { ...layout, panels };
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
