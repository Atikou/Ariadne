import { Profiler, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationMessageRow, EMPTY_RUN_ACTIVITIES } from '../../app/src/renderer/src/modules/chat/ConversationMessageRow';
import { ConversationMessage } from '../../app/src/renderer/src/modules/chat/ConversationMessage';
import { toConversationNode } from '../../app/src/renderer/src/modules/chat/ChatMessageProjection';
import '../../app/src/renderer/src/app/styles.css';

const root = createRoot(document.getElementById('root')!);
const services = { clipboard: { writeText: async () => {} }, sessions: {}, events: { emit() {}, emitRetained() {} } };
const noError = () => {};
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
let update;
let profilerSamples = [];
function BaselineRow({ node }) {
  return <div className={`conversation-node conversation-node--${node.kind}`}><ConversationMessage node={node}
    activities={EMPTY_RUN_ACTIVITIES} onCopy={async () => {}} /></div>;
}
function History({ count, optimized, ready }) {
  const [messages, setMessages] = useState(() => Array.from({ length: count }, (_, index) => ({
    messageId: 'history-' + index, sessionId: 'session-a', role: index % 4 === 0 ? 'user' : 'assistant',
    status: 'completed', content: 'Message ' + index + ': a retained answer with **formatted text** and a short explanation.',
    createdAt: '2026-09-05T00:00:00.000Z'
  })));
  useLayoutEffect(() => { update = text => setMessages(previous => [...previous.slice(0, -1), { ...previous.at(-1), status: 'streaming', content: text }]); ready(); }, []);
  useLayoutEffect(() => { const viewport = document.querySelector('.message-viewport'); viewport.scrollTop = viewport.scrollHeight; }, [messages]);
  return <Profiler id="history" onRender={(_id, phase, duration) => profilerSamples.push({ phase, duration })}>
    <div className="chat-panel chat-panel--sidebar-hidden" style={{height:'100vh'}}><div className="chat-sidebar-slot" hidden />
      <div className="chat-conversation"><header className="chat-header">Message history fixture</header>
        <div className="message-stage"><div className="message-viewport"><div className="message-list">
      {messages.map(message => optimized ? <ConversationMessageRow key={message.messageId} node={toConversationNode(message)}
        run={undefined} activities={EMPTY_RUN_ACTIVITIES} services={services} onError={noError} />
        : <BaselineRow key={message.messageId} node={toConversationNode({ ...message })} />)}
    </div></div></div><div className="composer-wrap"><div className="composer">Performance fixture</div></div></div></div>
  </Profiler>;
}
window.runHistoryBenchmark = async (count, optimized = true) => {
  profilerSamples = [];
  const started = performance.now();
  await new Promise(ready => root.render(<History key={count + ':' + optimized} count={count} optimized={optimized} ready={ready} />));
  await frame();
  const initialPaintMs = performance.now() - started;
  const updates = [];
  for (let index = 1; index <= 20; index++) {
    const at = performance.now();
    update('Live answer ' + 'token '.repeat(index));
    await frame();
    updates.push(performance.now() - at);
  }
  const sorted = [...updates].sort((a, b) => a - b);
  const last = [...document.querySelectorAll('.conversation-node')].at(-1).getBoundingClientRect();
  const viewport = document.querySelector('.message-viewport').getBoundingClientRect();
  return { count, optimized, initialPaintMs, updatePaintP50Ms: sorted[10], updatePaintP95Ms: sorted[18],
    nodes: document.querySelectorAll('*').length,
    liveVisible: last.top < viewport.bottom && last.bottom > viewport.top
      && document.body.textContent.includes(('Live answer ' + 'token '.repeat(20)).trim()) };
};
