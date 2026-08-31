import type { ComponentType } from 'react';
import type { AriadneApi, SystemCapability } from '@shared/contract';
import type { AppEventMap } from '../events/app-events';
import type { TypedEventBus } from '../events/typed-event-bus';
import type { RuntimeStore } from '../runtime/runtime-store';
import type { ConversationNavigationService } from '../conversations/conversation-navigation-service';
import type { SpeechCoordinator } from '../speech/speech-coordinator';
import type { ProductivityFeatureStore } from '../runtime/features/productivity-feature-store';

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

export interface ModuleServices {
  agentSettings: AriadneApi['agentSettings'];
  clipboard: AriadneApi['clipboard'];
  conversationNavigation: ConversationNavigationService;
  events: TypedEventBus<AppEventMap>;
  productivity: ProductivityFeatureStore;
  runtime: RuntimeStore;
  speech: SpeechCoordinator;
  preferences: AriadneApi['preferences'];
  system: AriadneApi['system'];
  terminal: AriadneApi['terminal'];
  workspace: AriadneApi['workspace'];
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
