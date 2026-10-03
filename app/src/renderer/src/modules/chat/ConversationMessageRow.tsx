import { memo } from 'react';
import type { RunActivity } from '@ariadne/protocol/public';
import { moduleId, type FeaturePanelProps } from '@renderer/core/modules/module-contract';
import type { RuntimeRun } from '@renderer/core/runtime/runtime-store';
import type { ConversationNode } from './conversation-node';
import { ConversationMessage } from './ConversationMessage';

const ACTIVITY_MODULE = moduleId('session.activity');
export const EMPTY_RUN_ACTIVITIES: RunActivity[] = [];

/** Stable history rows skip Markdown and disclosure work while the live row changes. */
export const ConversationMessageRow = memo(function ConversationMessageRow({ node, run, activities, workspaceId, services, onError }: {
  node: ConversationNode;
  run: RuntimeRun | undefined;
  activities: RunActivity[];
  workspaceId?: string | undefined;
  services: FeaturePanelProps['services'];
  onError(error: string | null): void;
}): React.JSX.Element {
  return <div id={`chat-node-${node.id}`} data-conversation-node className={`conversation-node conversation-node--${node.kind}`}>
    <ConversationMessage node={node} run={run} activities={activities} workspaceId={workspaceId} toolResults={services.toolResults}
      onOpenActivity={node.runId ? () => {
        services.events.emitRetained('session-activity:select-run', { runId: node.runId! });
        services.events.emit('module:open', ACTIVITY_MODULE);
      } : undefined}
      onCopy={text => services.clipboard.writeText({ text })}
      onFork={node.reference === undefined ? undefined : async () => {
        onError(null);
        try { await services.sessions.forkFromMessage(node.reference!.sessionId, node.reference!); }
        catch (error) { onError(error instanceof Error ? error.message : '无法从这条消息创建分支。'); }
      }} />
  </div>;
});
