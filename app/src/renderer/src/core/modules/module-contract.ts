import type { ComponentType } from 'react';
import type { AriadneApi, SystemCapability } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import type { TypedEventBus } from '../events/typed-event-bus';
import type { MockScenarioStore } from '../mock/mock-scenario';

export type ModuleId = string & { readonly __moduleId: unique symbol };
export type ModuleIcon =
  | 'activity'
  | 'bot'
  | 'file'
  | 'list'
  | 'message'
  | 'settings'
  | 'shield'
  | 'terminal'
  | 'tool';
export type PlacementDirection = 'above' | 'below' | 'left' | 'right' | 'within';
export type EdgePosition = 'bottom' | 'left' | 'right' | 'top';

export interface EdgePlacement {
  position: EdgePosition;
  groupId: string;
  initialSize: number;
  collapsedSize: number;
  collapsed: boolean;
}

export interface ModulePlacement {
  direction?: PlacementDirection;
  referenceModuleId?: ModuleId;
  initialWidth?: number;
  initialHeight?: number;
  edge?: EdgePlacement;
}

export interface ModuleServices {
  clipboard: AriadneApi['clipboard'];
  events: TypedEventBus<AppEventMap>;
  mock: MockScenarioStore;
  preferences: AriadneApi['preferences'];
  system: AriadneApi['system'];
  terminal: AriadneApi['terminal'];
  workspace: AriadneApi['workspace'];
}

export interface FeaturePanelProps {
  moduleId: ModuleId;
  services: ModuleServices;
}

export interface ModuleLifecycleContext {
  moduleId: ModuleId;
  services: ModuleServices;
}

export interface ModuleLifecycle {
  onCreate?(context: ModuleLifecycleContext): void | Promise<void>;
  onActivate?(context: ModuleLifecycleContext): void;
  onDeactivate?(context: ModuleLifecycleContext): void;
  onDispose?(context: ModuleLifecycleContext): void;
}

export interface FeatureModuleDefinition {
  id: ModuleId;
  name: string;
  description: string;
  icon: ModuleIcon;
  component: ComponentType<FeaturePanelProps>;
  defaultOpen: boolean;
  defaultPlacement: ModulePlacement;
  requiredCapabilities: readonly SystemCapability[];
  lifecycle?: ModuleLifecycle;
}

export function moduleId(value: string): ModuleId {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid module id: ${value}`);
  }
  return value as ModuleId;
}
