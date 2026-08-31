import type { ComponentType } from 'react';
import type { SystemCapability } from '@shared/contract';
import type { ModuleServices } from './module-services-contract';

export type { ModuleServices } from './module-services-contract';

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

export interface ModuleLayoutConstraints {
  minimumWidth: number;
}

export type ModuleServiceId = keyof ModuleServices;

export interface FeaturePanelProps {
  moduleId: ModuleId;
  services: ModuleServices;
}

export interface FeatureDialogProps {
  moduleId: ModuleId;
  open: boolean;
  services: ModuleServices;
  onClose(): void;
}

export interface ModuleNavigationContribution {
  id: string;
  label: string;
  icon: ModuleIcon;
  order: number;
  position: 'primary' | 'footer';
}

export type ModulePresentation =
  | { readonly kind: 'dock' }
  | {
      readonly kind: 'dialog';
      readonly component: ComponentType<FeatureDialogProps>;
    };

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
  consumes: readonly ModuleServiceId[];
  presentation?: ModulePresentation;
  navigation?: ModuleNavigationContribution;
  defaultOpen: boolean;
  defaultActivationOrder?: number;
  defaultPlacement: ModulePlacement;
  layoutConstraints: ModuleLayoutConstraints;
  requiredCapabilities: readonly SystemCapability[];
  lifecycle?: ModuleLifecycle;
}

export function moduleId(value: string): ModuleId {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid module id: ${value}`);
  }
  return value as ModuleId;
}
