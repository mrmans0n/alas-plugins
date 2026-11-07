import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testHost} from '@alas/plugin/test';
import './main.ts';
const sha=(n:number)=>String(n).padStart(40,'0');
const node=(n:number,base:string)=>({number:n,title:`PR ${n}`,url:`https://github.com/o/r/pull/${n}`,state:'OPEN',isDraft:false,author:{login:n===1?'ana':'nacho'},headRefName:`f${n}`,headRefOid:sha(n),baseRefName:base,baseRefOid:base==='f1'?sha(1):'a'.repeat(40),headRepository:{nameWithOwner:'o/r'},updatedAt:'2026-11-07T00:00:00Z',mergeable:'MERGEABLE',commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]},reactions:{nodes:[{user:{login:'chatgpt-codex-connector'}}]},autoMergeRequest:null as object|null});
const reviews=[node(1,'main'),node(2,'f1')];
let queued=true;
let state:any;
let saved:any;
const writes:any[]=[];
let acquired=0,released=0;
let holdListAt=0, listCount=0;
let heldList:{id:number;stdout:string}|undefined;
function drain():void {
  let turns=0;
  for(;;){
    const batch=testHost.takeSent();if(!batch.length)return;
    assert.ok(++turns<100,'bounded controller execution');
    for(const m of batch){
      const respond=(value:unknown)=>testHost.reply(m.id,value);
      switch(m.method){
        case 'web/post':state=m.params.message;break;
        case 'workspace/snapshot':respond({snapshot:{worktrees:[{id:'wt',branch:'main',main:true,current:true,sessions:[]}]}});break;
        case 'storage/get':respond({value:null});break;
        case 'storage/set':saved=m.params.value;respond({});break;
        case 'stacks/list':respond({inventory:{complete:true,busy:false,stacks:[]}});break;
        case 'stacks/acquire':acquired++;respond({token:'owned'});break;
        case 'stacks/release':released++;respond({released:true});break;
        case 'process/run':{
          const {id,args=[]}=m.params;
          let data:any;
          if(id==='list') data={viewer:{login:'nacho'},repository:{nameWithOwner:'o/r',url:'https://github.com/o/r',defaultBranchRef:{name:'main'},pullRequests:{nodes:reviews.filter(r=>r.state==='OPEN'),pageInfo:{hasNextPage:false,endCursor:null}}}};
          else if(id==='ci-api') {
            const number=Number(args.find((a:string)=>a.startsWith('number='))?.slice(7));
            const branch=args.find((a:string)=>a.startsWith('branch='))?.slice(7);
            data={repository:number?{pullRequest:reviews.find(r=>r.number===number)}:{pullRequests:{nodes:reviews.filter(r=>r.headRefName===branch&&r.state!=='OPEN'),pageInfo:{hasNextPage:false}}}};
          } else if(id==='merge') {
            writes.push({id,args});
            const r=reviews.find(r=>args[0]===r.url)!;assert.ok(r);assert.deepEqual(args,[r.url,'--match-head-commit',r.headRefOid]);
            if(queued) r.autoMergeRequest={enabledAt:'now'};else {r.state='MERGED';r.autoMergeRequest=null;}
          } else if(id==='stack-retarget') {
            writes.push({id,args});const r=reviews.find(r=>r.url===args[0])!;assert.ok(r);r.baseRefName=args[2];
          } else assert.fail(`Unexpected process ${id}`);
          const stdout=data?JSON.stringify({data}):'';
          if(id==='list' && holdListAt && ++listCount===holdListAt) {heldList={id:m.id,stdout};break;}
          respond({exit:0,stdout,stderr:'',truncated:false,timedOut:false});break;
        }
      }
    }
  }
}
const page=(message:unknown)=>{testHost.notify('web/message',{tab:0,message});drain();};
test('real API18 lifecycle: queued acceptance waits, Stop persists, Continue retargets and merges only after provider confirmation',()=>{
  testHost.dispatch({jsonrpc:'2.0',id:0,method:'alas/activate',params:{api:18,project:{id:'p',name:'P'},grants:[]}});drain();
  page({type:'scope',mine:true});
  page({type:'stack',action:'open',key:'github.com|o/r#2'});
  assert.equal(state.stacks.selected.entries.length,2);
  page({type:'stack',action:'prepare',key:'github.com|o/r#2'});
  assert.deepEqual(state.stacks.confirmation.members.map((r:any)=>r.identity.number),[1,2]);
  page({type:'stack',action:'confirm'});
  assert.equal(writes.length,1);
  assert.equal(state.stacks.operation.phase,'waiting');
  assert.equal(state.stacks.operation.done,0,'process success and auto merge acceptance are not a confirmed merge');
  assert.equal(acquired,1);assert.equal(released,0);
  testHost.notify('timer/fired',{id:'refresh'});drain();
  assert.equal(writes.length,1,'periodic refresh does not resubmit or advance queued members');
  page({type:'stack',action:'stop'});
  assert.equal(state.stacks.operation.phase,'stopped');assert.equal(released,1);assert.equal(saved.phase,'stopped');
  reviews[0].state='MERGED';reviews[0].autoMergeRequest=null;queued=false;
  page({type:'stack',action:'continue'});
  assert.deepEqual(writes.map(w=>w.id),['merge','stack-retarget','merge']);
  assert.equal(writes[1].args[2],'main');
  assert.equal(state.stacks.operation.phase,'complete');assert.equal(state.stacks.operation.done,2);
  assert.equal(acquired,2);assert.equal(released,2);
  assert.equal(saved,null);
});

test('Stop during the controller retarget preflight prevents a newly starting base edit and releases ownership',()=>{
  reviews[0].state='MERGED';reviews[1].state='OPEN';reviews[1].baseRefName='f1';
  page({type:'refresh'});
  page({type:'stack',action:'open',key:'github.com|o/r#2'});
  page({type:'stack',action:'prepare',key:'github.com|o/r#2'});
  const before=writes.length, releaseBefore=released;
  holdListAt=3;listCount=0;
  page({type:'stack',action:'confirm'});
  assert.ok(heldList,'hold the adapter read after pre-acquire and post-acquire controller reads');
  assert.equal(writes.length,before);
  page({type:'stack',action:'stop'});assert.equal(state.stacks.operation.phase,'stopping');
  holdListAt=0;
  testHost.reply(heldList!.id,{exit:0,stdout:heldList!.stdout,stderr:'',truncated:false,timedOut:false});drain();
  assert.equal(writes.length,before,'no retarget may start after Stop');
  assert.equal(state.stacks.operation.phase,'stopped');assert.equal(released,releaseBefore+1);
});
