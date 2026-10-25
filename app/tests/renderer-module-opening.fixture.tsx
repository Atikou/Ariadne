// Production module placement and menu with explicit in-memory service fixtures.
import { useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { Workspace, openModule } from '../src/renderer/src/app/Workspace';
import { ModuleMenu } from '../src/renderer/src/app/ModuleMenu';
import { ModuleRegistry } from '../src/renderer/src/core/modules/module-registry';
import { uiComponentDefinitions } from '../src/renderer/src/core/modules/UiComponentCatalog.generated';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';

const registry = new ModuleRegistry(uiComponentDefinitions().map(definition => ({
  ...definition,
  component: definition.id === 'memory.manage' ? definition.component : () => <p>【布局夹具】{definition.name}</p>
})));
const snapshot = { selectedSessionId: 'fixture-session', sessions: [{ sessionId: 'fixture-session', workspaceId: 'fixture-workspace' }] };
const services = {
  sessions: { view: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
  memory: { query: async () => ({ kind: 'memory.query_result', memories: [], nextCursor: null }) }
} as unknown as ModuleServices;
const fixture = { api: null as DockviewApi | null };
Object.assign(window, { __moduleOpeningFixture: fixture });
const noop = () => {};

export function ModuleOpeningFixture() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  window.ariadne = { layout: { load: async () => null, save: async () => {} } } as unknown as typeof window.ariadne;
  return <>
    <ModuleMenu modules={registry.list()} openModuleIds={openIds} onOpenModule={id => { if (api) openModule(api, registry, id); }} />
    <div style={{ position: 'absolute', inset: '40px 0 0' }}>
      <Workspace registry={registry} services={services} effectiveTheme="light" onApiReady={value => { fixture.api = value; setApi(value); }}
        onOpenModulesChanged={setOpenIds} onSaveStatusChanged={noop} />
    </div>
  </>;
}
