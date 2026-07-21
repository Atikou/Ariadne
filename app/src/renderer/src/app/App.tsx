import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, RotateCcw, Search, Waypoints } from 'lucide-react';
import type { DockviewApi } from 'dockview-react';
import type { ThemePreference } from '@shared/contract';
import { builtinModuleRegistry } from '@renderer/core/modules/builtin-modules';
import { createModuleServices } from '@renderer/core/services/module-services';
import type { ModuleId } from '@renderer/core/modules/module-contract';
import { MOCK_SCENARIOS, MOCK_SCENARIO_LABELS, useMockScenario, type MockScenario } from '@renderer/core/mock/mock-scenario';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';
import { SelectMenu, type SelectMenuOption } from '@renderer/shared/ui/SelectMenu';
import { ActivityBar } from './ActivityBar';
import { CommandPalette } from './CommandPalette';
import { GlobalStatusBar } from './GlobalStatusBar';
import { ModuleMenu } from './ModuleMenu';
import { openModule, resetWorkspace, Workspace, type SaveStatus } from './Workspace';

const mockScenarioOptions: readonly SelectMenuOption<MockScenario>[] = MOCK_SCENARIOS.map((value) => ({
  value,
  label: MOCK_SCENARIO_LABELS[value]
}));

export function App(): React.JSX.Element {
  const services = useMemo(() => createModuleServices(window.ariadne), []);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const [openModuleIds, setOpenModuleIds] = useState<ReadonlySet<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading');
  const [commandOpen, setCommandOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const scenario = useMockScenario(services.mock);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let preference: ThemePreference = 'system';
    const applyTheme = (): void => {
      const effective = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
      document.documentElement.dataset.theme = effective;
      document.documentElement.style.colorScheme = effective;
      void window.ariadne.window.setTitleBarTheme(effective);
    };
    void services.preferences.load().then((saved) => { preference = saved.theme; applyTheme(); });
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
          <SelectMenu
            className="mock-scenario-menu"
            ariaLabel="切换 Mock 状态"
            leadingIcon={<FlaskConical size={14} />}
            value={scenario}
            options={mockScenarioOptions}
            onChange={(value) => services.mock.setScenario(value)}
          />
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
          />
        </div>
      </div>
      <GlobalStatusBar services={services} saveStatus={saveStatus} />
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
