import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHost } from '@alas/plugin/test';
import './main.ts';
const node=(number:number)=>({number,title:`PR ${number}`,url:`https://github.com/o/r/pull/${number}`,state:'OPEN',isDraft:false,headRefName:`f${number}`,headRefOid:String(number).padStart(40,'0'),headRepository:{nameWithOwner:'o/r'},baseRefName:'main',baseRefOid:'a'.repeat(40),updatedAt:`2026-11-0${number}T00:00:00Z`,mergeable:'MERGEABLE',reactions:{nodes:[{user:{login:'chatgpt-codex-connector'}}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}});
const reviews=[node(1),node(2)];
const payload=()=>JSON.stringify({data:{repository:{nameWithOwner:'o/r',url:'https://github.com/o/r',defaultBranchRef:{name:'main'},pullRequests:{nodes:reviews.filter(r=>r.state==='OPEN'),pageInfo:{hasNextPage:false,endCursor:null}}}}});
let holdMerge=true,holdList=false;
let mergeRequest:any,listRequest:any,oldPayload:string;
let targeted=0;
const writes:number[]=[];
const result=(stdout='')=>({exit:0,stdout,stderr:'',truncated:false,timedOut:false});
function drain():void {
  for(let turn=0;turn<100;turn++){
    const sent=testHost.takeSent();if(!sent.length)return;
    for(const m of sent){
      const reply=(value:unknown)=>testHost.reply(m.id,value);
      switch(m.method){
        case 'workspace/snapshot':reply({snapshot:{worktrees:[{id:'wt',branch:'main',main:true,current:true,sessions:[]}]}});break;
        case 'storage/get':reply({value:null});break;
        case 'stacks/list':reply({inventory:{complete:true,busy:false,stacks:[]}});break;
        case 'stacks/acquire':reply({token:'owned'});break;
        case 'stacks/release':reply({released:true});break;
        case 'process/run':{
          const {id,args=[]}=m.params;
          if(id==='list') {if(holdList){listRequest=m;oldPayload=payload();}else reply(result(payload()));}
          else if(id==='merge'){
            const r=reviews.find(r=>r.url===args[0])!;assert.ok(r);writes.push(r.number);
            if(holdMerge)mergeRequest=m;else{r.state='MERGED';reply(result());}
          }else if(id==='ci-api'){
            const number=Number(args.find((a:string)=>a.startsWith('number='))?.slice(7));assert.ok(number);targeted++;
            reply(result(JSON.stringify({data:{repository:{pullRequest:reviews.find(r=>r.number===number)}}})));
          }else assert.fail(`Unexpected process ${id}`);
          break;
        }
      }
    }
  }
  assert.fail('provider loop did not settle');
}
const page=(message:unknown)=>{testHost.notify('web/message',{tab:0,message});drain();};
test('a stale refresh started during merge cannot consume post-command verification or stop Merge all',()=>{
  testHost.dispatch({jsonrpc:'2.0',id:0,method:'alas/activate',params:{api:18,project:{id:'p',name:'P'},grants:[]}});drain();
  page({type:'mergeAll'});assert.ok(mergeRequest);assert.deepEqual(writes,[2]);
  holdList=true;page({type:'refresh'});assert.ok(listRequest);
  reviews[1].state='MERGED';holdMerge=false;
  testHost.reply(mergeRequest.id,result());drain();
  holdList=false;testHost.reply(listRequest.id,result(oldPayload!));drain();
  assert.equal(targeted,2,'each successful merge is verified by identity in a fresh post-command batch');
  assert.deepEqual(writes,[2,1],'stale OPEN must not stop or consume the pending bulk operation');
});
