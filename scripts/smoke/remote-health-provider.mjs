import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = realpathSync.native(process.argv[2]);
const relative = path.relative(realpathSync.native(tmpdir()), root);
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('AriadneDomainHealth-'));
const trace = [], model = 't03-remote-health-fixture';
const controlPath = path.join(root, 'provider-control.json'), tracePath = path.join(root, 'provider-trace.json');
writeFileSync(controlPath, JSON.stringify({ available: false })); writeFileSync(tracePath, '[]');
const server = createServer({ pfx: readFileSync(path.join(root, 'provider.pfx')), passphrase: 'ariadne-electron-smoke' }, async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) { raw += String(chunk); if (raw.length > 16384) throw new Error('probe_too_large'); }
    const body = JSON.parse(raw), available = JSON.parse(readFileSync(controlPath, 'utf8')).available === true;
    const validProbe = request.method === 'POST' && request.url === '/v1/chat/completions'
      && request.headers.authorization === 'Bearer ariadne-electron-smoke-key' && body.model === model && body.stream === true
      && (body.tools === undefined || body.tools.length === 0) && body.messages?.length === 1
      && body.messages[0]?.role === 'user' && body.messages[0]?.content === 'Reply with READY.';
    const status = validProbe ? available ? 200 : 503 : 400;
    trace.push({ phase: available ? 'success' : 'failure', status, validProbe });
    writeFileSync(tracePath, JSON.stringify(trace, null, 2));
    if (status !== 200) { response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture Provider unavailable', type: 'temporary' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ model, choices: [{ delta: { content: 'READY' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch { trace.push({ phase: 'invalid', status: 400, validProbe: false }); writeFileSync(tracePath, JSON.stringify(trace)); response.writeHead(400); response.end(); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address(); assert(address && typeof address !== 'string');
  writeFileSync(path.join(root, 'provider-ready.json'), JSON.stringify({ baseUrl: `https://127.0.0.1:${address.port}/v1` }));
});
const close = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
process.once('SIGTERM', close); process.once('SIGINT', close);
