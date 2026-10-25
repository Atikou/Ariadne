import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectedTerminalRunMatches } from './smoke-projection-boundary.mjs';
const row = (contract, version, status) => ({ contract_version: contract, aggregate_version: version,
  dto_json: JSON.stringify(contract === '5.0' ? { runId: 'run-a', version, status }
    : { documentContractVersion: '1.0', summary: { runId: 'run-a', version, status } }) });
test('completed scalar and document rows both close the authority publication gap', () => {
  for (const contract of ['5.0', '6.0']) {
    assert.equal(projectedTerminalRunMatches(row(contract, 4, 'completed'), 'run-a', 4), true);
    assert.equal(projectedTerminalRunMatches(row(contract, 3, 'completed'), 'run-a', 4), false);
    assert.equal(projectedTerminalRunMatches(row(contract, 4, 'running'), 'run-a', 4), false);
  }
});
test('unknown, malformed or cross-owner rows cannot arm a false publication-boundary kill', () => {
  assert.throws(() => projectedTerminalRunMatches(row('7.0', 4, 'completed'), 'run-a', 4), /contract_invalid/);
  assert.throws(() => projectedTerminalRunMatches(row('6.0', 4, 'completed'), 'run-b', 4), /identity_invalid/);
  assert.throws(() => projectedTerminalRunMatches({ ...row('6.0', 4, 'completed'), dto_json: '{' }, 'run-a', 4));
});
