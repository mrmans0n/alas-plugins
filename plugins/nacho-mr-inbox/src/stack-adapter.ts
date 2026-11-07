import type { Outcome, ProcessResult } from "@alas/plugin";
import type { ReviewIdentity } from "@alas/plugin/stacks";
import type { StackAdapter, StackProviderSnapshot } from "../../../shared/inbox-stack-controller.ts";
import { fullSHA, reviewKey, type StackReview } from "../../../shared/inbox-stacks.ts";
import { parseInbox, parseStackReview, processError, type Inbox } from "./inbox.ts";
import { validRepo } from "./doctor.ts";
import { endpoint } from "./doctor-transport.ts";

type Driver = { run(id: string, wt: string, args: string[], done: (outcome: Outcome<ProcessResult>) => void, options?: { priority: boolean; alive?: () => boolean; started?: () => void }): void };
export const REVIEW_FIELDS = "iid title webUrl draft updatedAt author{username avatarUrl} sourceBranch targetBranch sourceProject{fullPath} targetProject{fullPath} diffHeadSha state autoMergeEnabled detailedMergeStatus conflicts approvalsLeft approvalsRequired reviewers{nodes{username mergeRequestInteraction{reviewState}}} resolvableDiscussionsCount resolvedDiscussionsCount headPipeline{id status sha jobs{count} done:jobs(statuses:[SUCCESS,FAILED,CANCELED,SKIPPED,MANUAL]){count} running:jobs(statuses:[RUNNING]){count}}";
const BLOCKERS = "blockingMergeRequests{totalCount hiddenCount visibleMergeRequests{iid targetProject{fullPath}}}";

/** Optional dependency metadata cannot break the primary inbox query on older GitLab hosts. */
export class MRStackAdapter implements StackAdapter {
  readonly mode = "queue" as const;
  private driver: Driver;
  private worktree: string;
  private changed: (inbox: Inbox) => void;
  private trains: () => boolean;
  private observe: (outcome: Outcome<ProcessResult>) => void;
  private previous?: Inbox;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private queuedWrites = new Set<() => void>();
  private waiters: { ids: ReviewIdentity[]; done: (snapshot?: StackProviderSnapshot, error?: string) => void }[] = [];
  constructor(driver: Driver, worktree: string, changed: (inbox: Inbox) => void, trains: () => boolean, observe: (outcome: Outcome<ProcessResult>) => void = () => {}) {
    this.driver = driver; this.worktree = worktree; this.changed = changed; this.trains = trains; this.observe = observe;
  }
  cancelPendingWrites(): void { this.generation++; for (const cancel of [...this.queuedWrites]) cancel(); }
  dispose(): void { this.disposed = true; this.cancelPendingWrites(); }
  refresh(ids: ReviewIdentity[], done: (snapshot?: StackProviderSnapshot, error?: string) => void): void {
    if (this.disposed) return done(undefined, "The plugin stopped.");
    this.waiters.push({ ids, done });
    if (!this.loading) this.start();
  }
  private start(): void {
    this.loading = true;
    const batch = this.waiters.splice(0);
    let inbox: Inbox | undefined, primaryError: string | undefined, dependencyError: string | undefined;
    let pages = 0, invalid = false;
    const cursors = new Set<string>();
    const finish = (error?: string) => {
      primaryError ??= error;
      if (!inbox && this.previous) inbox = { ...this.previous, mrs: [...this.previous.mrs], reviews: [...this.previous.reviews ?? []], complete: false };
      if (inbox) { inbox.complete = !!inbox.complete && !primaryError && !invalid; this.previous = inbox; this.changed(inbox); }
      const snapshot = { reviews: inbox?.reviews ?? [], complete: !!inbox?.complete, error: primaryError ?? dependencyError };
      for (const waiter of batch) waiter.done(snapshot, inbox ? undefined : primaryError ?? "GitLab returned no project.");
      this.loading = false;
      if (this.waiters.length) this.start();
    };
    const applyDependencies = (review: StackReview, value: any) => {
      const nodes = value?.visibleMergeRequests;
      const blockers: ReviewIdentity[] = [];
      let valid = Array.isArray(nodes) && nodes.length <= 500;
      if (valid) for (const node of nodes) {
        const number = typeof node?.iid === "string" && /^[1-9]\d{0,9}$/.test(node.iid) ? Number(node.iid) : 0;
        if (!number || !validRepo(node.targetProject?.fullPath)) { valid = false; continue; }
        blockers.push({ host: inbox!.host, repo: node.targetProject.fullPath, number });
      }
      review.blockers = [...new Map(blockers.map(id => [reviewKey(id), id])).values()];
      review.blockersComplete = valid && value.hiddenCount === 0 && value.totalCount === blockers.length && review.blockers.length === blockers.length;
      if (!review.blockersComplete) dependencyError = "GitLab dependency information is unavailable, hidden, or incomplete. Stack actions are read-only.";
    };
    const resolve = () => {
      const current = inbox!, attempted = new Set<string>(); let reads = 0;
      for (const review of current.reviews!) if (!review.blockersComplete) {
        const old = this.previous?.reviews?.find(r => reviewKey(r.identity) === reviewKey(review.identity));
        review.blockers = [...new Map([...(review.blockers ?? []), ...(old?.blockers ?? [])].map(id => [reviewKey(id), id])).values()];
      }
      const next = () => {
        const reviews = current.reviews!;
        const required = [...batch.flatMap(w => w.ids), ...reviews.flatMap(r => r.blockers ?? [])];
        for (const child of reviews) for (const old of this.previous?.reviews ?? []) {
          if (old.identity.host === current.host && old.sourceRepo === child.identity.repo && old.branch === child.base && reviewKey(old.identity) !== reviewKey(child.identity)) required.push(old.identity);
        }
        const missing = required.find(id => !reviews.some(r => reviewKey(r.identity) === reviewKey(id)) && !attempted.has(reviewKey(id)));
        if (!missing) { finish(); return; }
        if (++reads > 50 || reviews.length >= 550) { finish("Dependency resolution stopped at 50 reads; stack writes are unavailable."); return; }
        if (missing.host.toLowerCase() !== current.host.toLowerCase() || !validRepo(missing.repo)) { finish("A dependency host or project cannot be resolved."); return; }
        attempted.add(reviewKey(missing));
        this.graphql(current.host, missing.repo, `mergeRequest(iid:$iid){${REVIEW_FIELDS} ${BLOCKERS}}`, ["-f", `iid=${missing.number}`], (data, error) => {
          const raw = data?.project?.mergeRequest, review = parseStackReview(raw, current.host, missing.repo);
          if (error || !review || reviewKey(review.identity) !== reviewKey(missing)) { finish(error ?? "A required dependency is missing or inaccessible."); return; }
          reviews.push(review); applyDependencies(review, raw?.blockingMergeRequests); next();
        });
      }; next();
    };
    const dependencies = () => {
      const seen = new Set<number>(), dependencyCursors = new Set<string>(); let count = 0;
      const page = (cursor?: string) => this.graphql(inbox!.host, inbox!.project,
        `mergeRequests(state:opened,first:50,sort:UPDATED_DESC,after:$cursor){nodes{iid ${BLOCKERS}} pageInfo{hasNextPage endCursor}}`, cursor ? ["-f", `cursor=${cursor}`] : [], (data, error) => {
          const connection = data?.project?.mergeRequests, nodes = connection?.nodes;
          if (error || !Array.isArray(nodes)) { dependencyError = error ?? "GitLab dependency information is unavailable. Stack actions are read-only."; resolve(); return; }
          for (const raw of nodes) {
            const number = typeof raw?.iid === "string" ? Number(raw.iid) : 0;
            const review = inbox!.reviews!.find(r => r.identity.number === number && r.identity.repo === inbox!.project);
            if (!review || seen.has(number)) { dependencyError = "Dependency membership changed during refresh."; continue; }
            seen.add(number); applyDependencies(review, raw.blockingMergeRequests);
          }
          const info = connection.pageInfo; count++;
          if (info?.hasNextPage === true && typeof info.endCursor === "string" && info.endCursor.length > 0 && info.endCursor.length <= 2048 && count < 10 && !dependencyCursors.has(info.endCursor)) {
            dependencyCursors.add(info.endCursor); page(info.endCursor); return;
          }
          if (info?.hasNextPage !== false || seen.size !== inbox!.mrs.length) dependencyError = "GitLab dependency inventory is incomplete. Stack actions are read-only.";
          if (dependencyError) for (const review of inbox!.reviews!) review.blockersComplete = false;
          resolve();
        });
      page();
    };
    const page = (cursor?: string) => this.driver.run("list", this.worktree, cursor ? ["-f", `cursor=${cursor}`, "--hostname", inbox!.host] : [], outcome => {
      this.observe(outcome); pages++;
      const error = processError(outcome);
      if (error || outcome.result?.truncated) { finish(error ?? "The MR inventory was truncated."); return; }
      const fresh = parseInbox(outcome.result!.stdout);
      if (typeof fresh === "string") { finish(fresh); return; }
      const raw = JSON.parse(outcome.result!.stdout);
      invalid ||= !!raw.errors?.length || fresh.mrs.length !== raw.data.project.mergeRequests.nodes.length || fresh.reviews?.length !== fresh.mrs.length || !fresh.defaultBranch || !fresh.complete && !fresh.cursor;
      if (!inbox) inbox = fresh;
      else {
        if (fresh.host !== inbox.host || fresh.project !== inbox.project || fresh.defaultBranch !== inbox.defaultBranch || fresh.mrs.some(m => inbox!.mrs.some(old => old.iid === m.iid))) { finish("Project or page membership changed during refresh."); return; }
        inbox.mrs.push(...fresh.mrs); inbox.reviews!.push(...fresh.reviews!); inbox.complete = fresh.complete; inbox.cursor = fresh.cursor;
      }
      if (fresh.cursor) {
        if (pages >= 10 || inbox.mrs.length >= 500) { finish("Open MR inventory stopped at 500; stack writes are unavailable."); return; }
        if (cursors.has(fresh.cursor)) { finish("GitLab repeated a page cursor."); return; }
        cursors.add(fresh.cursor); page(fresh.cursor);
      } else if (invalid) finish("The MR inventory contains incomplete or malformed pages.");
      else dependencies();
    }, { priority: true });
    page();
  }
  private graphql(host: string, project: string, selection: string, variables: string[], done: (data?: any, error?: string) => void): void {
    const targeted = variables[1]?.startsWith("iid=");
    this.driver.run("stack-api", this.worktree, ["--hostname", host, "-F", `fullPath=${project}`, "-f", `query=query($fullPath:ID!,$${targeted ? "iid:String!" : "cursor:String"}){project(fullPath:$fullPath){${selection}}}`, ...variables], outcome => {
      this.observe(outcome); const failure = processError(outcome);
      if (failure || outcome.result?.truncated) return done(undefined, failure ?? "Dependency output was truncated.");
      let json: any;
      try { json = JSON.parse(outcome.result!.stdout); } catch { return done(undefined, "GitLab returned malformed dependency information."); }
      if (json.errors?.length) return done(undefined, "GitLab dependency information is unsupported or inaccessible. Stack actions are read-only.");
      done(json.data);
    }, { priority: true });
  }
  private write(id: string, args: string[], generation: number, done: (error?: string) => void): void {
    if (this.disposed || generation !== this.generation) return done('The pending write was stopped.');
    let started = false, settled = false;
    const settle = (error?: string) => {
      if (settled) return;
      settled = true;
      this.queuedWrites.delete(cancel);
      done(error);
    };
    const cancel = () => { if (!started) settle('The pending write was stopped.'); };
    this.queuedWrites.add(cancel);
    this.driver.run(id, this.worktree, args, outcome => {
      this.observe(outcome);
      settle(processError(outcome));
    }, { priority: true, alive: () => !settled, started: () => { started = true; } });
  }
  retry(rest: string, done: (error?: string) => void): void {
    const inbox = this.previous;
    if (!inbox) return done("Project identity is unavailable.");
    this.write("retry", [endpoint(inbox.project, rest), "--hostname", inbox.host], this.generation, done);
  }
  submit(member: StackReview, done: (error?: string) => void): void {
    if (this.disposed) return done("The plugin stopped before queueing.");
    if (!fullSHA(member.sha) || !member.sourceRepo || !member.base || !member.canQueue || member.queued || member.state !== "open") return done("The MR is not eligible for the merge train or auto-merge.");
    const train = this.trains();
    const path = train ? `merge_trains/merge_requests/${member.identity.number}` : `merge_requests/${member.identity.number}/merge`;
    const args = [endpoint(member.identity.repo, path), "--hostname", member.identity.host, "-f", `sha=${member.sha}`,
      ...(train ? member.ready ? [] : ["-f", "auto_merge=true"] : ["-f", "auto_merge=true", "-f", "merge_when_pipeline_succeeds=true"])];
    this.write(train ? "add" : "automerge", args, this.generation, done);
  }
  retarget(member: StackReview, base: string, done: (error?: string) => void): void {
    const generation = this.generation;
    this.refresh([member.identity], (snapshot, error) => {
      if (this.disposed || generation !== this.generation) return done("The action stopped before retargeting.");
      const fresh = snapshot?.reviews.find(r => reviewKey(r.identity) === reviewKey(member.identity));
      if (error || !snapshot?.complete || !fresh || fresh.sha !== member.sha || fresh.base !== member.base || fresh.branch !== member.branch || fresh.sourceRepo !== member.sourceRepo || fresh.state !== "open" || fresh.queued) return done(error ?? "MR changed before retargeting.");
      this.write("stack-retarget", [endpoint(member.identity.repo, `merge_requests/${member.identity.number}`), "--hostname", member.identity.host, "-f", `target_branch=${base}`], generation, failure => {
        if (failure) return done(failure);
        if (this.disposed || generation !== this.generation) return done("The retarget stopped after its process settled.");
        this.refresh([member.identity], (after, error) => {
          const verified = after?.reviews.find(r => reviewKey(r.identity) === reviewKey(member.identity));
          done(error ?? (!after?.complete || !verified || verified.sha !== member.sha || verified.base !== base || verified.sourceRepo !== member.sourceRepo || verified.branch !== member.branch || verified.state !== "open" ? "Retargeted base and unchanged head could not be confirmed." : undefined));
        });
      });
    });
  }
}
