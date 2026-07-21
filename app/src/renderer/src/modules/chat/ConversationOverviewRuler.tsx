import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createRulerEntries, resolveRulerCurrentId } from '@shared/ruler-model';
import { getNearestScrollDelta } from '@shared/scroll-geometry';
import type { ConversationNode, ConversationNodeKind } from './mock-chat-data';

interface ConversationOverviewRulerProps {
  nodes: readonly ConversationNode[];
  activeId: string | null;
  selectedId: string | null;
  onSelect(id: string): void;
}

interface HoveredNode {
  node: ConversationNode;
  top: number;
}

const PREVIEW_HALF_HEIGHT = 52;

const kindLabels: Record<ConversationNodeKind, string> = {
  assistant: 'Agent 回复',
  cancelled: '任务取消',
  complete: '任务完成',
  error: '执行错误',
  execution: '执行过程',
  offline: 'Runtime 状态',
  permission: '权限请求',
  proposal: '执行提案',
  streaming: '流式回复',
  tool: '工具调用',
  user: '用户消息'
};

export function ConversationOverviewRuler({
  nodes,
  activeId,
  selectedId,
  onSelect
}: ConversationOverviewRulerProps): React.JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tickRefs = useRef(new Map<string, HTMLButtonElement>());
  const [hovered, setHovered] = useState<HoveredNode | null>(null);

  const hoveredId = hovered?.node.id ?? null;
  const currentId = resolveRulerCurrentId(nodes, activeId, selectedId);
  const visualFocusId = hoveredId ?? currentId;
  const entries = createRulerEntries(nodes, hoveredId);

  useEffect(() => {
    if (!currentId) return;
    const scroll = scrollRef.current;
    const tick = tickRefs.current.get(currentId);
    if (!scroll || !tick) return;
    const scrollBounds = scroll.getBoundingClientRect();
    const tickBounds = tick.getBoundingClientRect();
    const delta = getNearestScrollDelta(
      scrollBounds.top,
      scrollBounds.bottom,
      tickBounds.top,
      tickBounds.bottom,
      18
    );
    if (delta !== 0) scroll.scrollTop += delta;
  }, [currentId]);

  if (nodes.length === 0) return null;

  const showPreview = (event: MouseEvent<HTMLButtonElement>, node: ConversationNode): void => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const scrollBounds = scroll.getBoundingClientRect();
    const tickBounds = event.currentTarget.getBoundingClientRect();
    const rawTop = tickBounds.top - scrollBounds.top + tickBounds.height / 2;
    const top = scroll.clientHeight >= PREVIEW_HALF_HEIGHT * 2
      ? Math.min(scroll.clientHeight - PREVIEW_HALF_HEIGHT, Math.max(PREVIEW_HALF_HEIGHT, rawTop))
      : scroll.clientHeight / 2;
    setHovered({
      node,
      top
    });
  };

  return (
    <nav className="conversation-ruler" aria-label="对话概览标尺" onMouseLeave={() => setHovered(null)}>
      <div
        ref={scrollRef}
        className="ruler-scroll"
        onScroll={() => setHovered(null)}
      >
        <div className="ruler-track">
          {entries.map(({ node, emphasisLevel }) => {
            return (
              <div className="ruler-entry" key={node.id}>
                <button
                  ref={(element) => {
                    if (element) tickRefs.current.set(node.id, element);
                    else tickRefs.current.delete(node.id);
                  }}
                  type="button"
                  className={`ruler-tick ruler-tick--level-${emphasisLevel}${activeId === node.id ? ' is-active' : ''}${visualFocusId === node.id ? ' is-emphasized' : ''}`}
                  data-ruler-node-id={node.id}
                  aria-label={`跳转到${kindLabels[node.kind]}：${node.summary}`}
                  aria-current={activeId === node.id ? 'location' : undefined}
                  aria-pressed={selectedId === node.id}
                  onMouseEnter={(event) => showPreview(event, node)}
                  onClick={() => onSelect(node.id)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {hovered && (
        <aside className="ruler-summary" aria-live="polite" style={{ top: hovered.top }}>
          <strong>{hovered.node.summary}</strong>
          <p>{hovered.node.sender} · {hovered.node.time} · {kindLabels[hovered.node.kind]}</p>
          <span className="ruler-summary-reference"><span aria-hidden="true">#</span>{hovered.node.id}</span>
        </aside>
      )}
    </nav>
  );
}
