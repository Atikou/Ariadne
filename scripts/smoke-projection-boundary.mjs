/** Both stored contracts remain valid history. Inspect their actual owner field;
 * malformed rows cannot be treated as evidence of a publication gap. */
export function projectedTerminalRunMatches(row, runId, authorityVersion) {
  const dto = JSON.parse(row.dto_json);
  let summary;
  if (row.contract_version === '5.0') summary = dto;
  else if (row.contract_version === '6.0' && dto.documentContractVersion === '1.0') summary = dto.summary;
  else throw new Error('smoke_projection_boundary_contract_invalid');
  if (summary?.runId !== runId || summary.version !== row.aggregate_version || typeof summary.status !== 'string') {
    throw new Error('smoke_projection_boundary_identity_invalid');
  }
  return row.aggregate_version >= authorityVersion && summary.status === 'completed';
}
