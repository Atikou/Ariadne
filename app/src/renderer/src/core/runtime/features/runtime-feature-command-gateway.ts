import type { RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';

export interface RuntimeFeatureCommandGateway {
  execute(command: RuntimeCommand, commandId?: string): Promise<RuntimeResult>;
}
