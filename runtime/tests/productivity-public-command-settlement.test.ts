import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteProductivityStore } from '../src/adapters/persistence/SqliteProductivityStore.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../src/control/conversation/ConversationAuthorityService.js';
import { ProductivityPublicCommandHandler, createProductivityCommandOwners } from '../src/composition/ProductivityPublicCommandHandler.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';
import { ProductivityCommandRejected } from '../src/adapters/persistence/ProductivityCommandRejected.js';
import { readPersistedAuthorityJson } from '../src/adapters/persistence/SqliteAuthorityHealth.js';
const roots:string[]=[], stores:Array<SqliteProductivityStore|SqliteConversationRunHandoffUnitOfWork>=[];
afterEach(async()=>{vi.restoreAllMocks();const context=createShutdownContext(Date.now()+5000);
 try{for(const store of stores.splice(0))await store.close(context);}finally{context.dispose();}
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function setup(){const root=mkdtempSync(path.join(tmpdir(),'AriadneProductivitySettlement-'));roots.push(root);
 const store=new SqliteProductivityStore(root), conversation=new SqliteConversationRunHandoffUnitOfWork(root);stores.push(store,conversation);
 await new ConversationAuthorityService(conversation).createSession({kind:'conversation.create_session',commandId:'create-session',eventId:'session-event',
  workspaceId:'workspace',sessionId:'session',expectedVersion:null,occurredAt:new Date().toISOString()});
 const command={kind:'goal.put',contractVersion:'5.0',workspaceId:'workspace',sessionId:'session',goalId:'goal',
  expectedVersion:null,title:'Original intent',phase:'implementation',status:'active',roundCap:8} as const;
 const envelope:RuntimeCommandEnvelope={commandId:'original-command',correlationId:'correlation',command,
  signal:new AbortController().signal,deadlineAt:new Date(Date.now()+10000).toISOString()};
 const owner=new ProductivityPublicCommandHandler(store,conversation,['workspace']);return {store,owner,command,envelope};}
it('returns completed only for an owning precondition rejection with no second mutation',async()=>{
 const h=await setup();await h.owner.execute(h.envelope,h.command);
 const rejected=await h.owner.execute({...h.envelope,commandId:'conflict'},h.command);
 expect(rejected).toMatchObject({settlement:'completed',outcome:{ok:false,error:{code:'productivity_version_conflict'}}});
 expect((await h.store.query('workspace','session')).goal?.version).toBe(1);
 expect(await h.store.reconcile('conflict',h.command)).toBeNull();
});
it('preserves a lost post-COMMIT reply and reconciles the original receipt without creating a new intent',async()=>{
 const h=await setup(), original=h.store.execute.bind(h.store), lost=new Error('goal_PRIVATE_COMMITTED_RESPONSE');
 const spy=vi.spyOn(h.store,'execute').mockImplementation(async(...args)=>{await original(...args);throw lost;});
 await expect(h.owner.execute(h.envelope,h.command)).rejects.toBe(lost);spy.mockRestore();
 expect(await h.owner.reconcile(h.envelope)).toMatchObject({settlement:'completed',outcome:{ok:true,result:{kind:'goal.updated',goal:{version:1}}}});
 expect((await h.store.query('workspace','session')).goal?.version).toBe(1);
});
it('does not leak arbitrary prefixed errors as public rejection codes',async()=>{
 const h=await setup(), unknown=new Error('schedule_PRIVATE_PATH_OR_BODY');vi.spyOn(h.store,'execute').mockRejectedValue(unknown);
 await expect(h.owner.execute(h.envelope,h.command)).rejects.toBe(unknown);
});
it('keeps failed reconciliation unknown rather than proving not_committed',async()=>{
 const h=await setup(), unknown=new Error('storage outcome unreadable');vi.spyOn(h.store,'reconcile').mockRejectedValue(unknown);
 const [owner]=createProductivityCommandOwners(h.owner);
  await expect(owner!.reconcile(h.envelope)).rejects.toBe(unknown);
});
it('gives an owning persisted-data fault priority over a reused business-validation error',async()=>{
 const h=await setup();let fault:unknown;
 try{readPersistedAuthorityJson('productivity','{}',()=>{throw new ProductivityCommandRejected('todo_dependency_cycle');});}
 catch(error){fault=error;}
 vi.spyOn(h.store,'execute').mockRejectedValue(fault);
 await expect(h.owner.execute(h.envelope,h.command)).rejects.toBe(fault);
});
