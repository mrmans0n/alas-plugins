import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInbox } from './inbox.ts';
const sha = 'a'.repeat(40);
const node = { number: 1, title: 'One', url: 'https://github.example/o/r/pull/1', isDraft: false, headRefName: 'one', headRefOid: sha, headRepository: { nameWithOwner: 'fork/r' }, baseRefName: 'main', baseRefOid: sha, state: 'OPEN', updatedAt: '', mergeable: 'MERGEABLE' };
export const fixture = (nodes: object[], more = false, cursor: string | null = null) => JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', url: 'https://github.example/o/r', defaultBranchRef: { name: 'main' }, pullRequests: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } } } } });
test('stack parser retains host, default base, source, head, state and page completion', () => {
  const inbox = parseInbox(fixture([node], true, 'next'))!;
  assert.equal(inbox.host, 'github.example');
  assert.equal(inbox.defaultBranch, 'main');
  assert.equal(inbox.complete, false);
  assert.equal(inbox.cursor, 'next');
  assert.deepEqual(inbox.reviews?.[0], { identity: { host: 'github.example', repo: 'o/r', number: 1 }, sourceRepo: 'fork/r', branch: 'one', base: 'main', sha, title: 'One', url: node.url, author: 'ghost', state: 'open', ready: false, queued: false, status: 'waiting' });
});
test('missing head/source/base stays visible but cannot become a write candidate', () => {
  for (const bad of [{headRefOid: null}, {headRepository: null}, {baseRefName: null}]) {
    const inbox = parseInbox(fixture([{...node, ...bad}]))!;
    assert.equal(inbox.pulls.length, 1);
    assert.equal(inbox.reviews?.[0].ready, false);
  }
});

import { PRStackAdapter } from './stack-adapter.ts';
const result = (stdout: string) => ({ result: { exit: 0, stdout, stderr: '', truncated:false, timedOut:false } });
test('adapter collects every page and stops at 500 with an explicit incomplete snapshot', () => {
  const calls: string[][] = [];
  const adapter = new PRStackAdapter({ run(_id, _wt, args, done) { calls.push(args); const n = calls.length; done(result(fixture(Array.from({length:50}, (_, i) => ({...node, number: (n-1)*50+i+1, baseRefName:'main'})), true, `c${n}`))); } }, 'wt', () => {});
  adapter.refresh([], snapshot => {
    assert.equal(snapshot?.reviews.length, 500);
    assert.equal(snapshot?.complete, false);
    assert.match(snapshot?.error ?? '', /500/);
  });
  assert.equal(calls.length, 10);
  assert.deepEqual(calls[1], ['-f', 'cursor=c1']);
});
test('adapter retains first-page data when the next page fails', () => {
  let n = 0;
  const adapter = new PRStackAdapter({run(_id, _wt, _args, done) { done(++n === 1 ? result(fixture([node], true, 'c')) : {error:{code:-1,message:'offline'}}); }}, 'wt', () => {});
  adapter.refresh([], snapshot => { assert.equal(snapshot?.reviews.length, 1); assert.equal(snapshot?.complete, false); assert.match(snapshot?.error ?? '', /offline/); });
});
test('stack submission guards the full head and never deletes a branch', () => {
  const args: string[][] = [];
  const adapter = new PRStackAdapter({run(_id, _wt, a, done) {args.push(a); done(result(''));}}, 'wt', () => {});
  adapter.submit(parseInbox(fixture([node]))!.reviews![0], error => assert.equal(error, undefined));
  assert.deepEqual(args[0], ['https://github.example/o/r/pull/1', '--match-head-commit', sha]);
  assert.equal(args[0].includes('--delete-branch'), false);
});

test('a malformed first page remains incomplete after a valid final page', () => {
  let calls=0;
  const adapter=new PRStackAdapter({run(_id,_wt,_args,done){done(result(++calls===1 ? fixture([node,{number:'bad'}],true,'next') : fixture([{...node,number:2}])));}},'wt',()=>{});
  adapter.refresh([],snapshot=>{assert.equal(snapshot?.reviews.length,2); assert.equal(snapshot?.complete,false);assert.match(snapshot?.error??'',/malformed/);});
});
test('a failed first page retains cached identity with explicit incomplete state', () => {
  let failing=false;
  const adapter=new PRStackAdapter({run(_id,_wt,_args,done){done(failing?{error:{code:-1,message:'offline'}}:result(fixture([node])));}},'wt',()=>{});
  adapter.refresh([],()=>{});failing=true;
  adapter.refresh([],snapshot=>{assert.equal(snapshot?.reviews[0].identity.number,1);assert.equal(snapshot?.complete,false);});
});
test('on-demand ancestor resolution preserves fork identity and closed versus merged state', () => {
  const calls:string[][]=[];
  const adapter=new PRStackAdapter({run(id,_wt,args,done){calls.push(args);done(result(id==='list'?fixture([{...node,headRepository:{nameWithOwner:'o/r'},baseRefName:'parent'}]):JSON.stringify({data:{repository:{pullRequests:{nodes:[{...node,number:2,headRepository:{nameWithOwner:'o/r'},headRefName:'parent',state:'CLOSED'}],pageInfo:{hasNextPage:false}}}}})));}},'wt',()=>{});
  adapter.refresh([],snapshot=>{assert.equal(snapshot?.complete,true);assert.equal(snapshot?.reviews[1].state,'closed');assert.equal(snapshot?.reviews[1].sourceRepo,'o/r');});
  assert.ok(calls[1].includes('branch=parent'));
  assert.ok(calls[1].includes('github.example'));
});
test('required frozen member missing from open pages is read by identity rather than assumed merged', () => {
  let n=0;
  const adapter=new PRStackAdapter({run(id,_wt,args,done){n++;done(result(id==='list'?fixture([]):JSON.stringify({data:{repository:{pullRequest:null}}})));}},'wt',()=>{});
  adapter.refresh([{host:'github.example',repo:'o/r',number:1}],snapshot=>{assert.equal(snapshot?.complete,false);assert.equal(snapshot?.reviews.length,0);assert.match(snapshot?.error??'',/missing|inaccessible/);});
  assert.equal(n,2);
});
test('retarget verifies both final base and unchanged head, and rejects an unconfirmed edit', () => {
  for (const rewritten of [false,true]) {
    let stage=0;
    const adapter=new PRStackAdapter({run(id,_wt,args,done){
      if(id==='stack-retarget'){assert.deepEqual(args,[node.url,'--base','trunk']);stage++;done(result(''));}
      else if(id==='list') done(result(fixture([{...node,baseRefName:stage?'trunk':'main',headRefOid:stage&&rewritten?'c'.repeat(40):sha}])));
      else done(result(JSON.stringify({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false}}}}}))); 
    }},'wt',()=>{});
    adapter.retarget(parseInbox(fixture([node]))!.reviews![0],'trunk',error=>assert.equal(!!error,rewritten));
  }
});

test('late verification refresh starts a new provider read after its request', () => {
  const pending:((outcome:any)=>void)[]=[];let first=false,second=false;
  const adapter=new PRStackAdapter({run(_id,_wt,_args,done){pending.push(done);}},'wt',()=>{});
  adapter.refresh([],()=>{first=true;});
  adapter.refresh([],()=>{second=true;});
  assert.equal(pending.length,1);
  pending[0](result(fixture([node])));
  assert.equal(first,true);assert.equal(second,false,'late verification must not consume an older read');
  assert.equal(pending.length,2);
  pending[1](result(fixture([node])));assert.equal(second,true);
});
test('reused historical branch without matching target OID cannot establish ancestry', () => {
  const adapter=new PRStackAdapter({run(id,_wt,_args,done){done(result(id==='list'?fixture([{...node,baseRefName:'parent',baseRefOid:'b'.repeat(40)}]):JSON.stringify({data:{repository:{pullRequests:{nodes:[{...node,number:2,headRepository:{nameWithOwner:'o/r'},headRefName:'parent',state:'MERGED'}],pageInfo:{hasNextPage:false}}}}})));}},'wt',()=>{});
  adapter.refresh([],snapshot=>{assert.equal(snapshot?.complete,false);assert.equal(snapshot?.reviews.length,1);assert.match(snapshot?.error??'',/identity|ancestor|branch/i);});
});

test('shutdown while retarget verification is pending prevents a new provider write', () => {
  const pending:((outcome:any)=>void)[]=[];const writes:string[]=[];let error:string|undefined;
  const adapter=new PRStackAdapter({run(id,_wt,_args,done){writes.push(id);pending.push(done);}},'wt',()=>{});
  adapter.retarget(parseInbox(fixture([node]))!.reviews![0],'trunk',failure=>{error=failure;});
  adapter.dispose();
  pending[0](result(fixture([node])));
  assert.deepEqual(writes,['list']);assert.match(error??'',/stopped/);
});

test('the tenth full page is complete when GitHub reports no next page', () => {
  let pages=0;
  const adapter=new PRStackAdapter({run(_id,_wt,_args,done){pages++;done(result(fixture(Array.from({length:50},(_,i)=>({...node,number:(pages-1)*50+i+1})),pages<10,`c${pages}`)));}},'wt',()=>{});
  adapter.refresh([],snapshot=>{assert.equal(snapshot?.reviews.length,500);assert.equal(snapshot?.complete,true);assert.equal(snapshot?.error,undefined);});
  assert.equal(pages,10);
});

import { ProcessQueue } from './doctor-transport.ts';
test('Stop during pre-edit verification cannot start a retarget command', () => {
  const pending:((outcome:any)=>void)[]=[];const writes:string[]=[];let error:string|undefined;
  const adapter=new PRStackAdapter({run(id,_wt,_args,done){writes.push(id);pending.push(done);}},'wt',()=>{});
  adapter.retarget(parseInbox(fixture([node]))!.reviews![0],'trunk',failure=>{error=failure;});
  adapter.cancelPendingWrites();
  pending[0](result(fixture([node])));
  assert.deepEqual(writes,['list']);assert.match(error??'',/stopped|cancelled/);
});
test('shutdown cancels a write waiting for a process slot and settles it exactly once', () => {
  const pending:((outcome:any)=>void)[]=[];const spawned:string[]=[];let callbacks=0;
  const queue=new ProcessQueue((id,_wt,_args,done)=>{spawned.push(id);pending.push(done);});
  queue.run('ci-api','wt',['first'],()=>{});queue.run('ci-api','wt',['second'],()=>{});
  const adapter=new PRStackAdapter(queue,'wt',()=>{});
  adapter.submit(parseInbox(fixture([node]))!.reviews![0],error=>{callbacks++;assert.match(error??'',/stopped|cancelled/);});
  adapter.dispose();
  assert.equal(callbacks,1,'cancelled queued action settles without waiting for unrelated work');
  pending[0](result(''));pending[1](result(''));
  assert.deepEqual(spawned,['ci-api','ci-api']);assert.equal(callbacks,1);
});
test('Stop after a merge actually starts waits for its process result before settling', () => {
  let pending:((outcome:any)=>void)|undefined;let callbacks=0;
  const queue=new ProcessQueue((_id,_wt,_args,done)=>{pending=done;});
  const adapter=new PRStackAdapter(queue,'wt',()=>{});
  adapter.submit(parseInbox(fixture([node]))!.reviews![0],()=>{callbacks++;});
  adapter.cancelPendingWrites();assert.equal(callbacks,0);
  pending!(result(''));assert.equal(callbacks,1);
});
