import type { Outcome, ProcessResult } from '@alas/plugin';
import type { ReviewIdentity } from '@alas/plugin/stacks';
import type { StackAdapter, StackProviderSnapshot } from '../../../shared/inbox-stack-controller.ts';
import { fullSHA, reviewKey, type StackReview } from '../../../shared/inbox-stacks.ts';
import type { RequestOptions } from './doctor-transport.ts';
import { parseInbox, parseStackReview, processError, type Inbox } from './inbox.ts';

type Driver = {run(id:string, wt:string, args:string[], done:(outcome: Outcome<ProcessResult>)=>void, options?: RequestOptions):void};
export const REVIEW_FIELDS = 'number title url state isDraft author{login avatarUrl(size:64)} headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid updatedAt reviewDecision mergeable autoMergeRequest{enabledAt} mergeQueueEntry{id} commits(last:1){nodes{commit{statusCheckRollup{state contexts{totalCount checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}} reactions(content:THUMBS_UP,first:50){nodes{user{login}}} eyes:reactions(content:EYES,first:50){nodes{user{login}}}';
const key = (r:StackReview) => reviewKey(r.identity);
/** All reads, including required merged members, use the same bounded process queue as CI Doctor. */
export class PRStackAdapter implements StackAdapter {
  readonly mode = 'merge' as const;
  private queue: Driver;
  private worktree:string;
  private changed:(inbox:Inbox)=>void;
  private observe:(outcome:Outcome<ProcessResult>)=>void;
  private waiters: {ids:ReviewIdentity[]; done:(snapshot?:StackProviderSnapshot,error?:string)=>void}[] = [];
  private loading = false;
  private disposed = false;
  private mutationGeneration = 0;
  private queuedWrites = new Set<() => void>();
  private previous?: Inbox;
  constructor(queue:Driver, worktree:string, changed:(inbox:Inbox)=>void, observe:(outcome:Outcome<ProcessResult>)=>void = () => {}) { this.queue=queue;this.worktree=worktree;this.changed=changed;this.observe=observe; }
  cancelPendingWrites():void {
    this.mutationGeneration++;
    for (const cancel of [...this.queuedWrites]) cancel();
  }
  dispose():void { this.disposed=true; this.cancelPendingWrites(); }
  refresh(ids:ReviewIdentity[], done:(snapshot?:StackProviderSnapshot,error?:string)=>void):void {
    if(this.disposed) return done(undefined,"The plugin stopped.");
    this.waiters.push({ids,done});
    if (this.loading) return;
    this.start();
  }
  private start():void {
    this.loading = true;
    const batch=this.waiters.splice(0);
    let inbox:Inbox | undefined;
    let pages = 0;
    let invalidPage = false;
    const cursors = new Set<string>();
    const finish = (error?:string) => {
      if (!inbox && this.previous) inbox = {...this.previous, pulls:[...this.previous.pulls], reviews:[...this.previous.reviews ?? []], complete:false};
      if (inbox) { inbox.complete = !!inbox.complete && !error && !invalidPage; this.previous=inbox; this.changed(inbox); }

      const snapshot = {reviews:inbox?.reviews ?? [], complete:!!inbox?.complete && !error, ...(error ? {error} : {})};
      for (const w of batch) w.done(snapshot, inbox ? undefined : error ?? 'GitHub returned an unexpected reply.');
      this.loading=false;
      if(this.waiters.length) this.start();
    };
    const resolve = () => {
      if (!inbox?.host || !inbox.defaultBranch || !inbox.complete) { finish('The pull request list or repository identity is incomplete.'); return; }
      let reads = 0;
      const attempted = new Set<string>();
      const next = () => {
        const reviews = inbox!.reviews!;
        const ids = batch.flatMap(w=>w.ids);
        const missing = ids.find(id => !reviews.some(r=>key(r)===reviewKey(id)) && !attempted.has(reviewKey(id)));
        const ancestor = reviews.find(r=>r.base && r.base !== inbox!.defaultBranch && !reviews.some(parent=>parent.sourceRepo?.toLowerCase() === r.identity.repo.toLowerCase() && parent.branch===r.base) && !attempted.has(`base:${r.base}`));
        if (!missing && !ancestor) { finish(); return; }
        if (++reads > 50) { finish('Dependency resolution stopped at 50 reads; refresh to retry.'); return; }
        const id = missing ?? ancestor!.identity;
        if (id.host.toLowerCase() !== inbox!.host!.toLowerCase() || id.repo.toLowerCase() !== inbox!.repo.toLowerCase()) { finish('A required request belongs to another repository.'); return; }
        const selection = missing ? `pullRequest(number:$number){${REVIEW_FIELDS}}` : `pullRequests(states:[MERGED,CLOSED],headRefName:$branch,first:5){nodes{${REVIEW_FIELDS}} pageInfo{hasNextPage}}`;
        attempted.add(missing ? reviewKey(id) : `base:${ancestor!.base}`);
        this.graphql(inbox!.host!, inbox!.repo, selection, missing ? ['-F',`number=${id.number}`] : ['-f',`branch=${ancestor!.base}`], (data,error) => {
          if (error) { finish(error); return; }
          const connection = data?.repository?.pullRequests;
          const nodes = missing ? [data?.repository?.pullRequest] : connection?.nodes;
          if (!Array.isArray(nodes) || !missing && connection?.pageInfo?.hasNextPage !== false) { finish('Dependency information is incomplete.'); return; }
          let parsed = nodes.map(n=>parseStackReview(n,inbox!.host!,inbox!.repo));
          if(!missing && nodes.length) {
            const target=inbox!.baseHeads?.[ancestor!.identity.number];
            parsed=parsed.filter(r=>r && r.sourceRepo?.toLowerCase()===ancestor!.identity.repo.toLowerCase() && r.branch===ancestor!.base && !!target && r.sha===target);
            if(parsed.length!==1) { finish('Historical ancestor branch identity is unresolved or ambiguous.'); return; }
          }
          if (parsed.some(r=>!r) || missing && parsed[0]?.identity.number!==id.number) { finish('A required request is missing or inaccessible.'); return; }
          for (const r of parsed as StackReview[]) if (!reviews.some(old=>key(old)===key(r))) {
            reviews.push(r);
            const raw=nodes.find(n=>n?.number===r.identity.number);
            if(fullSHA(raw?.baseRefOid)) (inbox!.baseHeads ??= {})[r.identity.number]=raw.baseRefOid;
          }
          next();
        });
      }; next();
    };
    const page = (cursor?:string) => this.queue.run('list', this.worktree, cursor ? ['-f',`cursor=${cursor}`] : [], outcome => {
      this.observe(outcome); pages++;
      const error = processError(outcome);
      if (error || outcome.result?.truncated) { finish(error ?? 'The pull request list was truncated.'); return; }
      const fresh = parseInbox(outcome.result!.stdout);
      if (!fresh) { finish('GitHub returned an unexpected reply.'); return; }
      invalidPage ||= !fresh.complete && !fresh.cursor || !fresh.host || !fresh.defaultBranch || fresh.reviews?.length !== fresh.pulls.length;
      // A cursor only proves there are more pages; malformed rows on any page remain incomplete.
      try { const json=JSON.parse(outcome.result!.stdout); invalidPage ||= !!json.errors?.length || fresh.pulls.length!==json.data.repository.pullRequests.nodes.length; } catch {invalidPage=true;}
      if (!inbox) inbox = fresh;
      else {
        if (fresh.host!==inbox.host || fresh.repo!==inbox.repo || fresh.defaultBranch!==inbox.defaultBranch || fresh.pulls.some(p=>inbox!.pulls.some(old=>old.number===p.number))) { finish('Repository or page membership changed during refresh.'); return; }
        inbox.baseHeads={...inbox.baseHeads,...fresh.baseHeads}; inbox.pulls.push(...fresh.pulls); inbox.reviews!.push(...fresh.reviews!); inbox.complete=fresh.complete; inbox.cursor=fresh.cursor;
      }
      if (fresh.cursor) {
        if (pages>=10 || inbox.pulls.length>=500) { finish('Open request inventory stopped at 500; stack writes are unavailable.'); return; }
        if (cursors.has(fresh.cursor)) { finish('GitHub repeated a page cursor.'); return; }
        cursors.add(fresh.cursor); page(fresh.cursor);
      } else if(invalidPage) finish("The pull request list contains incomplete or malformed pages."); else resolve();
    }, {priority:true});
    page();
  }
  private graphql(host:string, repo:string, selection:string, variables:string[], done:(data?:any,error?:string)=>void):void {
    const [owner,name] = repo.split('/');
    const extra = variables[1]?.startsWith('number=') ? ',$number:Int!' : ',$branch:String!';
    this.queue.run('ci-api',this.worktree,['graphql','--hostname',host,'-f',`query=query($owner:String!,$name:String!${extra}){repository(owner:$owner,name:$name){${selection}}}`,'-f',`owner=${owner}`,'-f',`name=${name}`,...variables], outcome=>{
      this.observe(outcome);
      const error=processError(outcome);
      if(error || outcome.result?.truncated) return done(undefined,error ?? 'Dependency output was truncated.');
      let json:any;
      try { json=JSON.parse(outcome.result!.stdout); }
      catch { return done(undefined,'GitHub returned malformed dependency information.'); }
      if(json.errors?.length) return done(undefined,'GitHub could not resolve dependency information.');
      done(json.data);
    },{priority:true});
  }
  submit(member:StackReview, done:(error?:string)=>void):void { this.merge(member,false,done); }
  mergeIndividual(member:StackReview, deleteBranch:boolean, done:(error?:string)=>void):void { this.merge(member,deleteBranch,done); }
  private merge(member:StackReview, deleteBranch:boolean, done:(error?:string)=>void):void {
    if(this.disposed) return done("The plugin stopped before merging.");
    if (!fullSHA(member.sha) || !member.base || !member.sourceRepo) return done('Request head, source or base identity is unavailable.');
    this.write('merge', [`https://${member.identity.host}/${member.identity.repo}/pull/${member.identity.number}`,'--match-head-commit',member.sha,...(deleteBranch?['--delete-branch']:[])], this.mutationGeneration, done);
  }
  private write(id: string, args: string[], generation: number, done: (error?: string) => void): void {
    if (this.disposed || generation !== this.mutationGeneration) return done('The pending write was stopped.');
    let started = false, settled = false;
    const settle = (error?: string) => {
      if (settled) return;
      settled = true;
      this.queuedWrites.delete(cancel);
      done(error);
    };
    const cancel = () => { if (!started) settle('The pending write was stopped.'); };
    this.queuedWrites.add(cancel);
    this.queue.run(id, this.worktree, args, outcome => {
      this.observe(outcome);
      settle(processError(outcome));
    }, { priority: true, alive: () => !settled, started: () => { started = true; } });
  }
  retarget(member:StackReview, base:string, done:(error?:string)=>void):void {
    const generation = this.mutationGeneration;
    // Refresh under reservation immediately before editing: GitHub has no conditional base-edit API.
    this.refresh([member.identity],(snapshot,error)=>{
      if(this.disposed || generation !== this.mutationGeneration) return done("The pending retarget was stopped.");
      const fresh=snapshot?.reviews.find(r=>key(r)===key(member));
      if(error || !snapshot?.complete || !fresh || fresh.sha!==member.sha || fresh.base!==member.base || fresh.state!=='open') return done(error ?? 'Request changed before retargeting.');
      this.write('stack-retarget', [`https://${member.identity.host}/${member.identity.repo}/pull/${member.identity.number}`,'--base',base], generation, failure => {
        if(failure) return done(failure);
        if(this.disposed || generation !== this.mutationGeneration) return done('The retarget was stopped after its process settled.');
        this.refresh([member.identity],(after,error)=>{
          const verified=after?.reviews.find(r=>key(r)===key(member));
          done(error ?? (!after?.complete || !verified || verified.sha!==member.sha || verified.base!==base ? 'Retargeted base or unchanged head could not be confirmed.' : undefined));
        });
      });
    });
  }
}
