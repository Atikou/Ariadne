const protocol = 'ariadne_runtime';
const protocolVersion = '2.0';
let capabilityBootstrap;

function sendReady(message) {
  process.send({
    protocol,
    protocolVersion,
    runtimeInstanceId: message.runtimeInstanceId,
    type: 'ready',
    runtimeVersion: process.env.ARIADNE_TEST_RUNTIME_VERSION || message.runtimeVersion,
    runtimeBuildFingerprint:
      process.env.ARIADNE_TEST_RUNTIME_BUILD_FINGERPRINT
      || message.runtimeBuildFingerprint,
    capabilities: [],
    storageSchemas: { fixture: 1 },
    readyAt: new Date().toISOString()
  }, () => process.send({
    protocol,
    protocolVersion,
    runtimeInstanceId: message.runtimeInstanceId,
    type: 'event',
    event: {
      eventId: 'fixture-ready-1',
      cursor: 1,
      schemaVersion: '2.0',
      aggregateType: 'runtime',
      aggregateId: 'runtime',
      aggregateVersion: 1,
      occurredAt: new Date().toISOString(),
      event: {
        kind: 'runtime.status.changed',
        status: {
          availability: 'ready',
          runtimeVersion: process.env.ARIADNE_TEST_RUNTIME_VERSION || message.runtimeVersion,
          runtimeBuildFingerprint:
            process.env.ARIADNE_TEST_RUNTIME_BUILD_FINGERPRINT
            || message.runtimeBuildFingerprint,
          protocolVersion,
          capabilities: [],
          observedAt: new Date().toISOString()
        }
      }
    }
  }));
}

process.on('message', (message) => {
  if (!message || message.protocol !== protocol || message.protocolVersion !== protocolVersion) {
    process.exit(91);
    return;
  }
  if (message.type === 'bootstrap') {
    if (process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'capability_on_bootstrap') {
      capabilityBootstrap = message;
      process.send({
        protocol,
        protocolVersion,
        runtimeInstanceId: message.runtimeInstanceId,
        type: 'capability_request',
        requestId: 'fixture-browser-health',
        capability: 'browser',
        operation: { kind: 'browser.health' }
      });
      return;
    }
    sendReady(message);
    return;
  }
  if (message.type === 'capability_response') {
    if (
      !capabilityBootstrap
      || message.requestId !== 'fixture-browser-health'
      || message.outcome?.ok !== true
      || message.outcome.result?.available !== true
    ) {
      process.exit(92);
      return;
    }
    const bootstrap = capabilityBootstrap;
    capabilityBootstrap = undefined;
    sendReady(bootstrap);
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
