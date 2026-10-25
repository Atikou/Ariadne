import type { FileDraftApi, FileDraftCatalog } from '../../src/shared/file-drafts';

/** In-memory unit/UI persistence fixture; no Main or OS encryption claim. */
export function memoryFileDraftApi(): FileDraftApi {
  let catalog: FileDraftCatalog = {revision:0,records:[]};
  return {resolvePath:async request=>({...request,comparisonPath:request.path,exists:true}),list:async()=>structuredClone(catalog),replace:async request=>{
    if(request.expectedRevision!==catalog.revision)throw new Error('fixture_file_draft_cas');
    catalog=structuredClone({revision:catalog.revision+1,records:request.records});return structuredClone(catalog);
  }};
}
