import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHost } from '@alas/plugin/test';
import './main.ts';
const sha='a'.repeat(40);
const original=()=>({number:1,title:'PR 1',url:'https://github.com/o/r/pull/1',state:'OPEN',isDraft:false,author:{login:'nacho'},headRefName:'feature',headRefOid:sha,headRepository:{nameWithOwner:'o/r'},baseRefName:'main',baseRefOid:'b'.repeat(40),updatedAt:'2026-11-07T00:00:00Z',mergeable:'MERGEABLE',reactions:{nodes:[{user:{login:'chatgpt-codex-connector'}}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}});
let review=original();
const native={id:'native',name:'Native',base:'main',host:'github.com',repo:'o/r',fingerprint:'native-fingerprint',worktree:'wt',complete:true,entries:[{id:'e1',number:1,sha,position:1,title:'PR 1'}],actions:['open','landThrough']};
let nativeStacks:unknown[]=[];
let holdAcquire=false,holdList=false,holdInventory=false;
let acquire:any,list:any,inventory:any;
const rawWrites:string[]=[];
let state:any;
let releases=0;
const result=(stdout='')=>({exit:0,stdout,stderr:'',truncated:false,timedOut:false});
const payload=()=>JSON.stringify({data:{repository:{nameWithOwner:'o/r',url:'https://github.com/o/r',defaultBranchRef:{name:'main'},pullRequests:{nodes:[review],pageInfo:{hasNextPage:false,endCursor:null}}}}});
function drain():void {
  for(let turn=0;turn<100;turn++){
    const batch=testHost.takeSent();if(!batch.length)return;
    for(const m of batch){
      const reply=(value:unknown)=>testHost.reply(m.id,value);
      switch(m.method){
        case 'web/post':state=m.params.message;break;
        case 'workspace/snapshot':reply({snapshot:{worktrees:[{id:'wt',branch:'main',main:true,current:true,sessions:[]}]}});break;
        case 'storage/get':reply({value:null});break;
        case 'stacks/list':if(holdInventory)inventory=m;else reply({inventory:{complete:true,busy:false,stacks:nativeStacks}});break;
        case 'stacks/acquire':if(holdAcquire)acquire=m;else reply({token:'owned'});break;
        case 'stacks/release':releases++;reply({released:true});break;
        case 'process/run':
          if(m.params.id==='list'){if(holdList)list=m;else reply(result(payload()));}
          else {rawWrites.push(m.params.id);reply({...result(),exit:1,stderr:'Unexpected raw provider write'});}
          break;
      }
    }
  }
  assert.fail('preflight fixture did not settle');
}
const page=(message:unknown)=>{testHost.notify('web/message',{tab:0,message});drain();};
const changed=()=>{testHost.notify('stacks/changed',{});drain();};
function reset():void {review=original();nativeStacks=[];changed();page({type:'refresh'});}
test('a newly mapped native root during ownership acquisition cannot fall through to raw gh',()=>{
  testHost.dispatch({jsonrpc:'2.0',id:0,method:'alas/activate',params:{api:18,project:{id:'p',name:'P'},grants:[]}});drain();
  holdAcquire=true;page({type:'merge',number:1});assert.ok(acquire);
  nativeStacks=[native];changed();
  holdAcquire=false;testHost.reply(acquire.id,{token:'owned'});drain();
  assert.deepEqual(rawWrites,[]);
  assert.match(state.inbox.stackRows[0].error??'',/native|changed|gg/i);
  assert.equal(releases,1);
});
test('source repository, source branch or head changing during preflight prevents a provider write',()=>{
  for(const change of [{headRepository:{nameWithOwner:'fork/r'}},{headRefName:'rewritten'},{headRefOid:'c'.repeat(40)}]){
    reset();const before=rawWrites.length;
    holdList=true;page({type:'merge',number:1});assert.ok(list);
    review={...review,...change};holdList=false;
    testHost.reply(list.id,result(payload()));drain();
    assert.equal(rawWrites.length,before,JSON.stringify(change));
    assert.match(state.inbox.stackRows[0].error??'',/changed/i);
  }
});
test('native inventory still refreshing at final provider preflight blocks raw gh',()=>{
  reset();const before=rawWrites.length;
  holdList=true;page({type:'merge',number:1});assert.ok(list);
  holdInventory=true;changed();assert.ok(inventory);
  holdList=false;testHost.reply(list.id,result(payload()));drain();
  assert.equal(rawWrites.length,before);
  assert.match(state.inbox.stackRows[0].error??'',/refresh|native|changed/i);
  holdInventory=false;testHost.reply(inventory.id,{inventory:{complete:true,busy:false,stacks:[]}});drain();
});
