import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin } from '@alas/plugin';
import { testHost } from '@alas/plugin/test';
import { InboxStackController } from '../../../shared/inbox-stack-controller.ts';
import { PRStackAdapter } from './stack-adapter.ts';
import { ProcessQueue } from './doctor-transport.ts';
const head='a'.repeat(40);
const review={number:1,title:'One',url:'https://github.com/o/r/pull/1',state:'OPEN',isDraft:false,headRefName:'feature',headRefOid:head,headRepository:{nameWithOwner:'o/r'},baseRefName:'main',baseRefOid:'b'.repeat(40),updatedAt:'2026-11-07T00:00:00Z',mergeable:'MERGEABLE',reactions:{nodes:[{user:{login:'chatgpt-codex-connector'}}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}};
const page=JSON.stringify({data:{repository:{nameWithOwner:'o/r',url:'https://github.com/o/r',defaultBranchRef:{name:'main'},pullRequests:{nodes:[review],pageInfo:{hasNextPage:false,endCursor:null}}}}});
const result=(stdout='')=>({result:{exit:0,stdout,stderr:'',truncated:false,timedOut:false}});
test('native invalidation after provider validation cancels a raw merge queued behind running reads',()=>{
  definePlugin({handle(){}});
  testHost.dispatch({jsonrpc:'2.0',id:0,method:'alas/activate',params:{api:18,project:{id:'p',name:'P'},grants:[]}});testHost.takeSent();
  const spawned:string[]=[];
  const pending:{id:string;done:(outcome:any)=>void}[]=[];
  const queue=new ProcessQueue((id,_wt,_args,done)=>{spawned.push(id);pending.push({id,done});});
  const adapter=new PRStackAdapter(queue,'wt',()=>{});
  const controller=new InboxStackController(adapter,()=>{});
  let released=0;
  const host=(holdInventory=false):any=>{
    let inventory:any;
    for(const m of testHost.takeSent()){
      if(m.method==='storage/get')testHost.reply(m.id,{value:null});
      else if(m.method==='stacks/acquire')testHost.reply(m.id,{token:'owned'});
      else if(m.method==='stacks/release'){released++;testHost.reply(m.id,{released:true});}
      else if(m.method==='stacks/list'){
        if(holdInventory)inventory=m;else testHost.reply(m.id,{inventory:{complete:true,busy:false,stacks:[]}});
      }else assert.fail(`Unexpected host request ${m.method}`);
    }
    return inventory;
  };
  controller.activate();host();
  let callbackCount=0,error:string|undefined;
  controller.runMutation(done=>{
    adapter.refresh([],snapshot=>{
      assert.ok(snapshot?.complete);controller.updateProvider(snapshot!);
      // The fresh provider read settled, then unrelated reads take both slots.
      queue.run('ci-api','wt',['first'],()=>{});
      queue.run('ci-api','wt',['second'],()=>{});
      adapter.mergeIndividual(snapshot!.reviews[0],true,done);
    });
  },failure=>{callbackCount++;error=failure;});
  host();
  assert.equal(pending[0].id,'list');
  pending.shift()!.done(result(page));
  assert.deepEqual(spawned,['list','ci-api','ci-api']);
  assert.equal(callbackCount,0,'merge is queued while the reservation remains owned');
  assert.equal(released,0);
  controller.refreshNative(false);
  assert.equal(callbackCount,0,'caller settles after the release reply');
  const inventory=host(true);assert.ok(inventory);
  assert.equal(callbackCount,1);assert.match(error??'',/stopped|cancelled/);
  assert.equal(released,1);assert.equal(controller.nativeRefreshing,true);
  while(pending.length)pending.shift()!.done(result());
  assert.deepEqual(spawned,['list','ci-api','ci-api'],'freeing process slots cannot spawn the invalidated merge');
  testHost.reply(inventory.id,{inventory:{complete:true,busy:false,stacks:[]}});
  assert.equal(controller.nativeRefreshing,false);assert.equal(controller.busy,false);
  assert.equal(released,1);assert.equal(callbackCount,1);
});
