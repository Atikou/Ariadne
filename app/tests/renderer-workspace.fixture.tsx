// Production workspace with in-memory layout only; never connects to Preload.
import type { DockviewApi } from 'dockview-react';
import { useLayoutEffect } from 'react';
import { Workspace } from '../src/renderer/src/app/Workspace';
import { applyThemeToDocument, type EffectiveTheme } from '../src/renderer/src/app/theme-sync';
import { ModuleRegistry } from '../src/renderer/src/core/modules/module-registry';
import { moduleId, type FeatureModuleDefinition, type ModuleServices } from '../src/renderer/src/core/modules/module-contract';

const definitions: FeatureModuleDefinition[] = ['会话', '文件浏览', '任务状态', '执行计划', '工具输出', '终端', '运行日志', '目标与工作流'].map((name, index) => ({
  id: moduleId(`fixture.panel-${index}`), name, description: '仅用于 UI 检查', icon: 'list',
  component: ({ moduleId }) => <p style={{ padding: 16 }}>【UI 夹具】{moduleId}</p>,
  consumes: [], requiredCapabilities: [], defaultOpen: true,
  defaultPlacement: index ? { referenceModuleId: moduleId('fixture.panel-0'), direction: 'within' } : {},
  layoutConstraints: { minimumWidth: 100 }
}));
const registry = new ModuleRegistry(definitions);
const services = {} as ModuleServices;
const fixture = {
  api: null as DockviewApi | null,
  setTheme: (theme: EffectiveTheme) => applyThemeToDocument(document, theme)
};
Object.assign(window, { __workspaceFixture: fixture });
const noop = () => {};
const ready = (api: DockviewApi) => { fixture.api = api; };

export function WorkspaceFixture() {
  useLayoutEffect(() => { fixture.setTheme('dark'); }, []);
  window.ariadne = { layout: { load: async () => null, save: async () => {} } } as unknown as typeof window.ariadne;
  return <Workspace registry={registry} services={services} effectiveTheme="dark" onApiReady={ready} onOpenModulesChanged={noop} onSaveStatusChanged={noop} />;
}
