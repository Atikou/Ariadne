const protocol = 'ariadne_runtime';
const protocolVersion = '3.0';
let capabilityBootstrap;
let cancellationObserved = false;
let timedOutRequestId;

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
      aggregateType: 'trace',
      aggregateId: 'fixture-ready-trace',
      aggregateVersion: 1,
      occurredAt: new Date().toISOString(),
      event: {
        kind: 'trace.appended',
        entry: {
          traceId: 'fixture-ready-trace',
          level: 'info',
          category: 'fixture',
          message: 'Runtime fixture ready.',
          occurredAt: new Date().toISOString()
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
    if (process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'delayed_ready_abort_gate') {
      setTimeout(() => sendReady(message), 100);
      return;
    }
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
    if (
      process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'delayed_ready_abort_gate'
      && message.commandId === 'command-cancel-during-start'
    ) {
      process.exit(94);
      return;
    }
    if (process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'crash_on_request') {
      process.exit(17);
      return;
    }
    if (
      process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'cancel_gate'
      && message.commandId === 'command-timeout'
    ) {
      timedOutRequestId = message.requestId;
      return;
    }
    if (
      process.env.ARIADNE_TEST_RUNTIME_BEHAVIOR === 'cancel_gate'
      && !cancellationObserved
    ) {
      process.exit(93);
      return;
    }
    process.send({
      protocol,
      protocolVersion,
      runtimeInstanceId: message.runtimeInstanceId,
      type: 'response',
      requestId: message.requestId,
      commandId: message.commandId,
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
  if (message.type === 'cancel') {
    const status = (
      message.commandId === 'command-timeout'
      && message.targetRequestId === timedOutRequestId
    ) ? 'accepted' : 'attempt_mismatch';
    if (status === 'accepted') cancellationObserved = true;
    process.send({
      protocol,
      protocolVersion,
      runtimeInstanceId: message.runtimeInstanceId,
      type: 'cancel_acknowledged',
      cancelRequestId: message.cancelRequestId,
      targetRequestId: message.targetRequestId,
      commandId: message.commandId,
      status
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
