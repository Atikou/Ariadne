import { Readable, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  agent as createAcpAgent,
  methods,
  ndJsonStream
} from '@agentclientprotocol/sdk';

createAcpAgent({ name: 'ariadne-acp-test-agent' })
  .onRequest(methods.agent.initialize, () => Promise.resolve({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      promptCapabilities: { image: false, audio: false, embeddedContext: false }
    },
    authMethods: []
  }))
  .onRequest(methods.agent.session.new, () => Promise.resolve({
    sessionId: 'ariadne-acp-test-session'
  }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (process.argv[2] === 'permission') {
      const permission = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'fixture-tool-call',
            title: 'sensitive fixture title',
            kind: 'execute'
          },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        }
      );
      if (permission.outcome.outcome === 'cancelled') {
        return { stopReason: 'cancelled' };
      }
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `external:${text}` }
      }
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => Promise.resolve())
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin)
  ));
