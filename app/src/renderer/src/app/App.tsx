import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Search, Waypoints } from 'lucide-react';
import type { DockviewApi } from 'dockview-react';
import type { ThemePreference } from '@shared/contract';
import { builtinModuleRegistry } from '@renderer/core/modules/builtin-modules';
import { createModuleServices } from '@renderer/core/services/module-services';
import type { ModuleId } from '@renderer/core/modules/module-contract';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';
import { ActivityBar } from './ActivityBar';
import { ApprovalCenter } from './ApprovalCenter';
import { CommandPalette } from './CommandPalette';
import { GlobalStatusBar } from './GlobalStatusBar';
import { ModuleMenu } from './ModuleMenu';
import { applyThemeToDocument, resolveEffectiveTheme, type EffectiveTheme } from './theme-sync';
import { openModule, resetWorkspace, Workspace, type SaveStatus } from './Workspace';

export function App(): React.JSX.Element {
  const services = useMemo(() => createModuleServices(window.ariadne), []);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const [openModuleIds, setOpenModuleIds] = useState<ReadonlySet<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading');
  const [commandOpen, setCommandOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ));
  const runtime = useRuntimeSnapshot(services.runtime);

  useEffect(() => {
    void services.runtime.initialize();
    return () => services.runtime.dispose();
  }, [services]);

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
    if (dockviewApi) openModule(dockviewApi, builtinModuleRegistry, id);
  };

  const handleOpenModules = (ids: readonly ModuleId[]): void => {
    if (!dockviewApi) return;
    for (const id of ids) openModule(dockviewApi, builtinModuleRegistry, id);
  };

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
          <span className={`runtime-title-status runtime-title-status--${runtime.status.availability}`}>
            Runtime {formatRuntimeAvailability(runtime.status.availability)}
          </span>
          <ModuleMenu
            modules={builtinModuleRegistry.list()}
            openModuleIds={openModuleIds}
            onOpenModule={handleOpenModule}
          />
          <button className="icon-button" type="button" title="重置布局" onClick={() => setResetDialogOpen(true)}>
            <RotateCcw size={15} />
          </button>
        </div>
      </header>
      <div className="app-main">
        <ActivityBar openModuleIds={openModuleIds} onOpen={handleOpenModules} />
        <div className="workspace-frame">
          <Workspace
            registry={builtinModuleRegistry}
            services={services}
            onApiReady={setDockviewApi}
            onOpenModulesChanged={setOpenModuleIds}
            onSaveStatusChanged={setSaveStatus}
            effectiveTheme={effectiveTheme}
          />
        </div>
      </div>
      <GlobalStatusBar services={services} saveStatus={saveStatus} />
      <ApprovalCenter services={services} />
      <CommandPalette
        open={commandOpen}
        registry={builtinModuleRegistry}
        onClose={() => setCommandOpen(false)}
        onOpenModule={handleOpenModule}
      />
      <ConfirmDialog
        open={resetDialogOpen}
        title="重置工作区布局？"
        description="当前停靠位置、分组和面板尺寸将恢复为默认布局。"
        confirmLabel="重置布局"
        onClose={() => setResetDialogOpen(false)}
        onConfirm={() => {
          if (dockviewApi) resetWorkspace(dockviewApi, builtinModuleRegistry);
          setResetDialogOpen(false);
        }}
      />
    </main>
  );
}
