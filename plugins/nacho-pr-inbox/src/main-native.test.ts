import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHost } from '@alas/plugin/test';
import './main.ts';
const sha=(n:number)=>String(n).padStart(40,'0');
const node=(n:number,base:string)=>({number:n,title:`PR ${n}`,url:`https://github.com/o/r/pull/${n}`,state:'OPEN',isDraft:false,author:{login:'nacho'},headRefName:`f${n}`,headRefOid:sha(n),headRepository:{nameWithOwner:'o/r'},baseRefName:base,baseRefOid:base==='f1'?sha(1):'a'.repeat(40),updatedAt:'2026-11-07T00:00:00Z',mergeable:'MERGEABLE',reactions:{nodes:[{user:{login:'chatgpt-codex-connector'}}]},commits:{nodes:[{commit:{statusCheckRollup:{state:'SUCCESS'}}}]}});
const reviews=[node(1,'main'),node(2,'f1')];
const native={id:'native',name:'Native',base:'main',host:'github.com',repo:'o/r',fingerprint:'native-fingerprint',worktree:'wt',complete:true,entries:reviews.map((r,i)=>({id:`e${r.number}`,number:r.number,sha:r.headRefOid,position:i+1,title:r.title})),actions:['open','land','landThrough']};
let state:any;
const opened:any[]=[];
const providerWrites:string[]=[];
function drain():void {
  for(let turn=0;turn<100;turn++){
    const batch=testHost.takeSent();if(!batch.length)return;
    for(const m of batch){
      const reply=(result:unknown)=>testHost.reply(m.id,result);
      switch(m.method){
        case 'web/post':state=m.params.message;break;
        case 'workspace/snapshot':reply({snapshot:{worktrees:[{id:'wt',branch:'main',main:true,current:true,sessions:[]}]}});break;
        case 'storage/get':reply({value:null});break;
        case 'stacks/list':reply({inventory:{complete:true,busy:false,stacks:[native]}});break;
        case 'stacks/open':opened.push(m.params);reply({opened:true});break;
        case 'process/run':{
          const {id,args=[]}=m.params;let data:any;
          if(id==='list')data={repository:{nameWithOwner:'o/r',url:'https://github.com/o/r',defaultBranchRef:{name:'main'},pullRequests:{nodes:reviews.filter(r=>r.state==='OPEN'),pageInfo:{hasNextPage:false,endCursor:null}}}};
          else if(id==='ci-api'){
            const number=Number(args.find((a:string)=>a.startsWith('number='))?.slice(7));
            data={repository:number?{pullRequest:reviews.find(r=>r.number===number)}:{pullRequests:{nodes:reviews.filter(r=>r.state==='MERGED'),pageInfo:{hasNextPage:false}}}};
          }else {providerWrites.push(id);assert.fail(`Native action spawned ${id}`);}
          reply({exit:0,stdout:JSON.stringify({data}),stderr:'',timedOut:false,truncated:false});break;
        }
      }
    }
  }
  assert.fail('native fixture loop did not settle');
}
const page=(message:unknown)=>{testHost.notify('web/message',{tab:0,message});drain();};
test('native individual actions land only the eligible selected entry through native confirmation',()=>{
  testHost.dispatch({jsonrpc:'2.0',id:0,method:'alas/activate',params:{api:18,project:{id:'p',name:'P'},grants:[]}});drain();
  const rows=()=>state.inbox.stackRows;
  assert.equal(rows().find((r:any)=>r.number===1).merge.label,'Land this…');
  assert.equal(rows().find((r:any)=>r.number===1).merge.short,'Land…');
  assert.equal(rows().find((r:any)=>r.number===1).merge.disabled,false);
  assert.equal(rows().find((r:any)=>r.number===2).merge.disabled,true);
  page({type:'merge',number:2});assert.equal(opened.length,0,'unmerged ancestor prevents the native prefix dialog');
  page({type:'merge',number:1});
  assert.deepEqual(opened,[{stack:'native',fingerprint:'native-fingerprint',action:'landThrough',entry:'e1'}]);
  reviews[0].state='MERGED';
  page({type:'refresh'});
  assert.equal(rows().find((r:any)=>r.number===2).merge.disabled,false);
  page({type:'merge',number:2});
  assert.deepEqual(opened[1],{stack:'native',fingerprint:'native-fingerprint',action:'landThrough',entry:'e2'});
  assert.deepEqual(providerWrites,[]);
});
