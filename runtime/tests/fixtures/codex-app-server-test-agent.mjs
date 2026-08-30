import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'initialized') return;
  if (frame.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'thread-test', ephemeral: true } } });
    return;
  }
  if (frame.method === 'turn/start') {
    const prompt = frame.params.input[0].text;
    send({ jsonrpc: '2.0', id: frame.id, result: { turn: { id: 'turn-test' } } });
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId: 'thread-test',
          turnId: 'turn-test',
          item: { type: 'agentMessage', phase: 'final_answer', text: `codex:${prompt}` }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } }
      });
    }, 10);
  }
});
