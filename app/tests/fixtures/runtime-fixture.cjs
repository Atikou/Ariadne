const protocol = 'ariadne_runtime';
const protocolVersion = '1.0';

process.on('message', (message) => {
  if (!message || message.protocol !== protocol || message.protocolVersion !== protocolVersion) {
    process.exit(91);
    return;
  }
  if (message.type === 'bootstrap') {
    process.send({
      protocol,
      protocolVersion,
      runtimeInstanceId: message.runtimeInstanceId,
      type: 'ready',
      runtimeVersion: process.env.ARIADNE_TEST_RUNTIME_VERSION || message.runtimeVersion,
      capabilities: [],
      storageSchemas: { fixture: 1 },
      readyAt: new Date().toISOString()
    });
    return;
  }
  if (message.type === 'request') {
    if (process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'crash_on_request') {
      process.exit(17);
      return;
    }
    process.send({
      protocol,
      protocolVersion,
      runtimeInstanceId: message.runtimeInstanceId,
      type: 'response',
      requestId: message.requestId,
      outcome: {
        ok: true,
        result: {
          kind: 'runtime.status',
          status: {
            availability: 'ready',
            runtimeVersion: 'test',
            protocolVersion,
            capabilities: [],
            observedAt: new Date().toISOString()
          }
        }
      }
    });
    return;
  }
  if (message.type === 'shutdown') {
    process.send({
      protocol,
      protocolVersion,
      runtimeInstanceId: message.runtimeInstanceId,
      type: 'shutdown_complete',
      requestId: message.requestId,
      completedAt: new Date().toISOString()
    }, () => process.disconnect());
  }
});
