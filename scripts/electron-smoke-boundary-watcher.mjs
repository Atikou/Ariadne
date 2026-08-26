import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const options = parseArguments(process.argv.slice(2));
const agentDatabasePath = requireOption(options, 'agent-db');
const projectionDatabasePath = requireOption(options, 'projection-db');
const effectMarkerPath = requireOption(options, 'effect-marker');
const projectionMarkerPath = requireOption(options, 'projection-marker');

let agent = null;
let projection = null;
const deadline = Date.now() + 180_000;

try {
  while (Date.now() < deadline) {
    agent ??= openWhenReady(agentDatabasePath);
    projection ??= openWhenReady(projectionDatabasePath);
    try {
      if (agent !== null && !existsSync(effectMarkerPath) && effectStarted(agent)) {
        writeFileSync(effectMarkerPath, 'effect_started_authority_committed', 'utf8');
      }
      if (
        agent !== null
        && projection !== null
        && !existsSync(projectionMarkerPath)
        && terminalRunAwaitingProjection(agent, projection)
      ) {
        writeFileSync(projectionMarkerPath, 'terminal_authority_projection_pending', 'utf8');
      }
    } catch {
      // Writers use zero busy timeout and fail closed. The observer never
      // competes by retrying a busy snapshot in the same turn.
    }
    if (existsSync(effectMarkerPath) && existsSync(projectionMarkerPath)) process.exit(0);
    await delay(5);
  }
  throw new Error('electron_smoke_boundary_watcher_timeout');
} finally {
  projection?.close();
  agent?.close();
}

function openWhenReady(path) {
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function effectStarted(database) {
  return database.prepare(`
    WITH target AS (
      SELECT json_extract(event_json, '$.payload.effect.effectId') AS effect_id
        FROM agent_v3_outbox
       WHERE json_extract(event_json, '$.payload.type')='effect.registered'
         AND json_extract(event_json, '$.payload.effect.toolCallId')='smoke-crash-effect-call'
       LIMIT 1
    )
    SELECT 1 AS observed
      FROM agent_v3_outbox, target
     WHERE json_extract(event_json, '$.payload.type')='effect.transitioned'
       AND json_extract(event_json, '$.payload.effectId')=target.effect_id
       AND json_extract(event_json, '$.payload.to.status')='started'
     LIMIT 1
  `).get()?.observed === 1;
}

function terminalRunAwaitingProjection(agentDatabase, projectionDatabase) {
  const source = agentDatabase.prepare(`
    SELECT aggregate_id AS run_id
      FROM agent_v3_outbox
     WHERE event_json LIKE '%"toolCallId":"smoke-crash-projection-call"%'
     ORDER BY cursor DESC
     LIMIT 1
  `).get();
  if (typeof source?.run_id !== 'string') return false;
  const authority = agentDatabase.prepare(`
    SELECT version, state_status
      FROM agent_v3_runs
     WHERE run_id=?
  `).get(source.run_id);
  if (authority?.state_status !== 'completed') return false;
  const projected = projectionDatabase.prepare(`
    SELECT aggregate_version, dto_json
      FROM projection_versions
     WHERE feature='runs' AND aggregate_id=?
     ORDER BY aggregate_version DESC
     LIMIT 1
  `).get(source.run_id);
  if (projected === undefined) return true;
  let dto;
  try {
    dto = JSON.parse(projected.dto_json);
  } catch {
    return true;
  }
  return projected.aggregate_version < authority.version || dto?.status !== 'completed';
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid_arguments');
    result[key.slice(2)] = value;
  }
  return result;
}

function requireOption(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing_option:${key}`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
