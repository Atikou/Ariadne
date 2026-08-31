import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Search, Waypoints } from 'lucide-react';
import type { DockviewApi } from 'dockview-react';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import type { ThemePreference } from '@shared/contract';
import type { ModuleRegistry } from '@renderer/core/modules/module-registry';
import type { ModuleId, ModuleServices } from '@renderer/core/modules/module-contract';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';
import { ActivityBar } from './ActivityBar';
import { CommandPalette } from './CommandPalette';
import { GlobalStatusBar } from './GlobalStatusBar';
import { ModuleMenu } from './ModuleMenu';
import { applyThemeToDocument, resolveEffectiveTheme, type EffectiveTheme } from './theme-sync';
import { openModule, resetWorkspace, Workspace, type SaveStatus } from './Workspace';

export function App({
  services,
  registry
}: {
  services: ModuleServices;
  registry: ModuleRegistry;
}): React.JSX.Element {
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const [openModuleIds, setOpenModuleIds] = useState<ReadonlySet<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading');
  const [commandOpen, setCommandOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [dialogModuleId, setDialogModuleId] = useState<ModuleId | null>(null);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ));
  const runtime = useRuntimeSnapshot(services.runtime);
  const closeDialog = useCallback(() => setDialogModuleId(null), []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let preference: ThemePreference = 'system';
    const applyTheme = (): void => {
      const effective = resolveEffectiveTheme(preference, media.matches);
      applyThemeToDocument(document, effective);
      setEffectiveTheme(effective);
      void window.ariadne.window.setTitleBarTheme(effective).catch((error: unknown) => {
        console.error('Title bar theme could not be synchronized.', error);
      });
    };
    applyTheme();
    void services.preferences.load()
      .then((saved) => { preference = saved.theme; applyTheme(); })
      .catch((error: unknown) => {
        console.error('Desktop preferences could not be loaded.', error);
      });
    const unsubscribe = services.events.subscribe('preferences:changed', (saved) => { preference = saved.theme; applyTheme(); });
    media.addEventListener('change', applyTheme);
    return () => { unsubscribe(); media.removeEventListener('change', applyTheme); };
  }, [services]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleOpenModule = (id: ModuleId): void => {
    const definition = registry.get(id);
    if (definition?.presentation?.kind === 'dialog') {
      setCommandOpen(false);
      setDialogModuleId(id);
      return;
    }
    if (dockviewApi) openModule(dockviewApi, registry, id);
  };

  const handleOpenModules = (ids: readonly ModuleId[]): void => {
    for (const id of ids) handleOpenModule(id);
  };

  const visibleOpenModuleIds = dialogModuleId === null
    ? openModuleIds
    : new Set([...openModuleIds, dialogModuleId]);
  const dialogDefinition = dialogModuleId === null
    ? undefined
    : registry.get(dialogModuleId);
  const activeDialog = dialogDefinition?.presentation?.kind === 'dialog'
    ? {
        moduleId: dialogDefinition.id,
        Component: dialogDefinition.presentation.component,
        services: registry.servicesFor(dialogDefinition.id, services)
      }
    : undefined;

  useEffect(() => services.events.subscribe('module:open', (id) => {
    const definition = registry.get(id);
    if (definition) handleOpenModule(definition.id);
  }), [services, dockviewApi]);

  return (
    <main className="app-shell">
      <header className="app-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark"><Waypoints size={17} /></span>
          <span>Ariadne</span>
          <span className="title-divider" />
          <span className="current-task-title">完善桌面端模块化架构</span>
        </div>
        <button type="button" className="command-entry" onClick={() => setCommandOpen(true)}>
          <Search size={14} /><span>搜索或输入命令</span><kbd>Ctrl K</kbd>
        </button>
        <div className="titlebar-actions">
          <span
            className={`runtime-title-status runtime-title-status--${runtime.status.availability}`}
            data-runtime-availability={runtime.status.availability}
          >
            Runtime {formatRuntimeAvailability(runtime.status.availability)}
          </span>
          <ModuleMenu
            modules={registry.list()}
            openModuleIds={visibleOpenModuleIds}
            onOpenModule={handleOpenModule}
          />
          <button className="icon-button" type="button" title="重置布局" onClick={() => setResetDialogOpen(true)}>
            <RotateCcw size={15} />
          </button>
        </div>
      </header>
      <div className="app-main">
        <ActivityBar
          actions={registry.navigationActions()}
          openModuleIds={visibleOpenModuleIds}
          onOpen={handleOpenModules}
        />
        <div className="workspace-frame">
          <Workspace
            registry={registry}
            services={services}
            onApiReady={(api) => {
              for (const definition of registry.list()) {
                if (definition.presentation?.kind === 'dialog') {
                  api.getPanel(definition.id)?.api.close();
                }
              }
              setDockviewApi(api);
            }}
            onOpenModulesChanged={setOpenModuleIds}
            onSaveStatusChanged={setSaveStatus}
            effectiveTheme={effectiveTheme}
          />
        </div>
      </div>
      <GlobalStatusBar services={services} saveStatus={saveStatus} />
      <CommandPalette
        open={commandOpen}
        registry={registry}
        onClose={() => setCommandOpen(false)}
        onOpenModule={handleOpenModule}
        runtime={services.runtime}
        workspaceId={runtime.sessions.find((session) => session.sessionId === runtime.selectedSessionId)?.workspaceId ?? PERSONAL_ASSISTANT_WORKSPACE_ID}
      />
      <ConfirmDialog
        open={resetDialogOpen}
        title="重置工作区布局？"
        description="当前停靠位置、分组和面板尺寸将恢复为默认布局。"
        confirmLabel="重置布局"
        onClose={() => setResetDialogOpen(false)}
        onConfirm={() => {
          if (dockviewApi) resetWorkspace(dockviewApi, registry);
          setResetDialogOpen(false);
        }}
      />
      {activeDialog && (
        <activeDialog.Component
          moduleId={activeDialog.moduleId}
          open
          services={activeDialog.services}
          onClose={closeDialog}
        />
      )}
    </main>
  );
}
