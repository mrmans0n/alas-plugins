import type { Snapshot } from "@alas/plugin";
import { processError } from "./inbox.ts";
import { attemptKey, attemptNumbers, brief, evidenceKey, failed, packCache, remoteRepo, restoreCache, validRepo, validSHA, type Attempt, type Evidence, type Job, type Observation, type PullIdentity, type Run } from "./doctor.ts";
import { GitHub, ProcessQueue, type RequestOptions, type Result } from "./doctor-transport.ts";

export interface DoctorPull { number: number; title: string; url: string; branch: string; identity?: PullIdentity }
export interface Verification { worktree: string; sha: string; repo: string; at: number; mismatch: boolean }
export interface Dispatch {
  token: number; job: number; text: string; question: string; session?: string; verification?: Verification;
  acknowledged: boolean; phase: "preview" | "verifying" | "sending" | "sent" | "failed"; error?: string;
}
export interface DoctorState {
  target?: { repo: string; pull: DoctorPull }; evidence?: Evidence; loading: boolean; historyLoading: boolean;
  cached: boolean; historical: boolean; error?: string; selectedAttempt?: string; selectedJob?: number;
  snapshot: Snapshot; dispatch?: Dispatch;
}
interface Hooks {
  changed(): void; save(value: unknown): void; snapshot(done: (s: Snapshot) => void): void;
  send(session: string, text: string, done: (error?: string) => void): void; now(): number;
}
export class DoctorController {
  readonly state: DoctorState = { loading: false, historyLoading: false, cached: false, historical: false, snapshot: { worktrees: [] } };
  private github: GitHub;
  private queue: ProcessQueue;
  private hooks: Hooks;
  private generation = 0;
  private dispatchToken = 0;
  private snapshotRevision = 0;
  private cache = new Map<string, Evidence>();
  constructor(github: GitHub, queue: ProcessQueue, hooks: Hooks) { this.github = github; this.queue = queue; this.hooks = hooks; }
  private changed(persist = false): void {
    if (persist && this.state.evidence) {
      this.cache.set(this.state.evidence.key, this.state.evidence);
      const packed = packCache([...this.cache.values()]);
      this.cache = new Map(packed.entries.map(e => [e.key, e]));
      this.hooks.save(packed);
    }
    this.hooks.changed();
  }
  restore(value: unknown): void {
    for (const e of restoreCache(value)) if (!this.cache.has(e.key)) this.cache.set(e.key, e);
    const t = this.state.target;
    if (t?.pull.identity && !this.state.evidence) {
      const e = this.cache.get(evidenceKey(t.repo, t.pull.number, t.pull.identity.sha));
      if (e) { this.state.evidence = e; this.state.cached = true; this.changed(); }
    }
  }
  updateSnapshot(snapshot: Snapshot): void {
    this.snapshotRevision++;
    this.state.snapshot = snapshot;
    const d = this.state.dispatch;
    const owner = d?.session && snapshot.worktrees.find(w => w.sessions.some(s => s.id === d.session && !["detached", "failed", "unknown"].includes(s.state)));
    if (d?.session && (!owner || (d.verification && owner.id !== d.verification.worktree))) {
      d.token = ++this.dispatchToken;
      d.verification = undefined;
      if (d.phase !== "sent" && d.phase !== "sending") d.phase = "failed";
      d.error = "The selected session or its worktree ownership changed. Copy the brief or prepare a new investigation.";
    }
    this.changed();
  }
  updateInbox(repo: string, pulls: DoctorPull[]): void {
    const e = this.state.evidence;
    if (!e) return;
    const p = pulls.find(p => p.number === e.number);
    if (repo !== e.repo || !p || (p.identity && p.identity.sha !== e.head.sha)) {
      this.generation++; this.state.historical = true; this.state.loading = false; this.state.historyLoading = false; this.state.dispatch = undefined;
      if (p && this.state.target) this.state.target.pull = p;
      this.changed();
    }
  }
  close(): void { this.generation++; this.state.target = undefined; this.state.dispatch = undefined; this.state.loading = false; this.state.historyLoading = false; this.changed(); }
  refresh(): void { if (this.state.target) { this.generation++; this.github.retry(); this.open(this.state.target.repo, this.state.target.pull); } }
  open(repo: string, pull: DoctorPull): void {
    if (!validRepo(repo)) return;
    const gen = ++this.generation;
    const options = { alive: () => gen === this.generation };
    const old = pull.identity && this.cache.get(evidenceKey(repo, pull.number, pull.identity.sha));
    Object.assign(this.state, { target: { repo, pull }, evidence: old, loading: true, cached: !!old, historical: false, historyLoading: false, error: undefined, selectedAttempt: undefined, selectedJob: undefined, dispatch: undefined });
    this.changed();
    this.github.identity(repo, pull.number, r => {
      if (!r.value) { this.state.loading = false; this.state.error = r.error; return this.changed(); }
      const head = r.value;
      const key = evidenceKey(repo, pull.number, head.sha);
      const cached = this.cache.get(key);
      const until = new Date(this.hooks.now()).toISOString();
      const e: Evidence = { key, repo, number: pull.number, title: pull.title, url: pull.url, head, fetchedAt: cached?.fetchedAt ?? this.hooks.now(), runs: [], attempts: cached?.attempts.slice() ?? [], logs: { ...cached?.logs }, observations: [], coverage: [], since: new Date(this.hooks.now() - 14 * 86400_000).toISOString(), until };
      this.state.evidence = e;
      this.state.cached = !!cached;
      this.state.target!.pull = { ...pull, identity: head };
      this.changed();
      this.github.runs(repo, { branch: head.branch, since: e.since, until: e.until }, runs => {
        this.state.loading = false;
        if (runs.error) { e.error = runs.error; this.state.error = runs.error; e.runs = cached?.runs ?? []; }
        else {
          e.fetchedAt = this.hooks.now(); this.state.cached = false;
          // Branch alone is never a PR identity. REST PR association or exact repository+SHA is required.
          e.runs = (runs.value ?? []).filter(run => this.isPR(run, e));
        }
        if (!runs.complete) e.coverage.push(runs.warning ?? runs.error ?? "Run history incomplete.");
        this.changed(true);
        if (e.runs.length) this.selectAttempt(e.runs[0].id, e.runs[0].attempt);
      }, options);
    }, options);
  }
  private isPR(run: Run, e: Evidence): boolean {
    return run.prs.includes(e.number) || (run.headRepo.toLowerCase() === e.head.repo.toLowerCase() && run.sha === e.head.sha);
  }
  selectAttempt(id: number, attempt: number): void {
    const e = this.state.evidence;
    const run = e?.runs.find(r => r.id === id);
    if (!e || !run || !attemptNumbers(run.attempt).includes(attempt)) return;
    const gen = ++this.generation;
    const options = { alive: () => gen === this.generation };
    this.state.selectedAttempt = attemptKey(id, attempt);
    this.state.selectedJob = undefined; this.state.dispatch = undefined; this.state.historyLoading = false;
    const cached = e.attempts.find(a => a.run.id === id && a.run.attempt === attempt);
    if (cached && cached.run.status === "completed" && !this.state.cached) { this.state.loading = false; return this.changed(); }
    this.state.loading = true; this.changed();
    this.loadAttempt(e, run, attempt, result => {
      this.state.loading = false;
      if (result.value) this.keepAttempt(e, result.value);
      if (result.error) this.state.error = result.error;
      this.changed(true);
    }, options);
  }
  private keepAttempt(e: Evidence, a: Attempt): void {
    const i = e.attempts.findIndex(x => x.run.id === a.run.id && x.run.attempt === a.run.attempt);
    if (i < 0) e.attempts.push(a); else e.attempts[i] = a;
  }
  private loadAttempt(e: Evidence, run: Run, attempt: number, done: (r: Result<Attempt>) => void, options: RequestOptions): void {
    this.github.run(e.repo, run.id, attempt, metadata => {
      if (!metadata.value || metadata.value.id !== run.id || metadata.value.attempt !== attempt || metadata.value.workflow !== run.workflow) return done({ error: metadata.error ?? "Run attempt identity changed; refresh details.", complete: false });
      this.github.jobs(e.repo, run.id, attempt, jobs => {
        const previous = e.attempts.find(a => a.run.id === run.id && a.run.attempt === attempt);
        const live = jobs.value ?? [];
        const stale = !jobs.complete ? (previous?.jobs ?? []).filter(j => !live.some(l => l.id === j.id)) : [];
        const retained = stale.slice(0, Math.max(0, 100 - live.length));
        const omitted = retained.length < stale.length ? " Cached jobs omitted to keep the 100-job bound." : "";
        const value: Attempt = { run: metadata.value!, jobs: [...live, ...retained].slice(0, 100), complete: jobs.complete, error: (jobs.error ?? jobs.warning ?? "") + omitted || undefined, fetchedAt: retained.length ? previous?.fetchedAt : this.hooks.now(), ...(retained.length ? { cachedJobs: retained.map(j => j.id) } : {}) };
        done({ value, complete: jobs.complete, error: jobs.error });
      }, options);
    }, options);
  }
  selectJob(id: number): void {
    const e = this.state.evidence;
    const a = this.currentAttempt();
    const job = a?.jobs.find(j => j.id === id);
    if (!e || !a || !job) return;
    const gen = ++this.generation;
    const options = { alive: () => gen === this.generation };
    this.state.selectedJob = id; this.state.dispatch = undefined; this.state.historyLoading = true; this.state.loading = false;
    e.observations = [];
    this.changed();
    const history = () => this.history(e, a.run, job, options);
    if (e.logs[String(id)] && !e.logs[String(id)].error && a.run.status === "completed") return history();
    this.github.log(e.repo, id, log => {
      const old = e.logs[String(id)];
      e.logs[String(id)] = log.value ?? { ...(old ?? { text: "", truncated: false }), error: log.error ?? "Logs unavailable" };
      this.changed(true); history();
    }, options);
  }
  currentAttempt(): Attempt | undefined { return this.state.evidence?.attempts.find(a => attemptKey(a.run.id, a.run.attempt) === this.state.selectedAttempt); }
  currentJob(): Job | undefined { return this.currentAttempt()?.jobs.find(j => j.id === this.state.selectedJob); }
  private history(e: Evidence, selected: Run, job: Job, options: RequestOptions): void {
    const sources: { side: "pr" | "base"; branch: string }[] = [{ side: "pr", branch: e.head.branch }, { side: "base", branch: e.head.baseBranch }];
    const tasks: { side: "pr" | "base"; run: Run; attempt: number }[] = [];
    const warn = (s: string) => { if (!e.coverage.includes(s)) e.coverage.push(s); };
    const summaries = (index: number) => {
      if (index >= sources.length) return details(0);
      const source = sources[index];
      this.github.runs(e.repo, { branch: source.branch, workflow: selected.workflow, since: e.since, until: e.until }, r => {
        if (!r.complete) warn(`${source.side} history: ${r.error ?? r.warning ?? "incomplete"}`);
        const candidates = (r.value ?? []).filter(run => run.workflow === selected.workflow && (source.side === "pr" ? this.isPR(run, e) : run.branch === e.head.baseBranch && run.event === "push" && run.headRepo.toLowerCase() === e.repo.toLowerCase()));
        if (candidates.length > 5) warn(`${source.side}: examined only the latest 5 matching runs of ${candidates.length} summaries.`);
        if (!candidates.length) warn(`${source.side}: no comparable runs in the observation window.`);
        for (const run of candidates.slice(0, 5)) {
          const attempts = attemptNumbers(run.attempt);
          if (run.attempt > 5) warn(`Run ${run.id}: attempts between 2 and ${run.attempt - 4} omitted.`);
          for (const attempt of attempts) tasks.push({ side: source.side, run, attempt });
        }
        summaries(index + 1);
      }, options);
    };
    const details = (index: number): void => {
      if (index >= tasks.length) return logs(0, e.observations.filter(o => failed(o.job.conclusion)).slice(0, 4));
      const task = tasks[index];
      const consume = (r: Result<Attempt>) => {
        if (!r.complete) warn(`Run ${task.run.id} attempt ${task.attempt}: ${r.error ?? r.value?.error ?? "incomplete jobs"}`);
        if (r.value) {
          if (task.side === "pr") this.keepAttempt(e, r.value);
          const matching = r.value.jobs.filter(j => j.name === job.name);
          if (!matching.length) warn(`Run ${task.run.id} attempt ${task.attempt}: comparable job absent.`);
          for (const j of matching) if (j.id !== job.id) {
            if (e.observations.length < 100) e.observations.push({ side: task.side, run: r.value.run, job: j });
            else warn("Comparison observations incomplete: stopped at 100 matching jobs.");
          }
        }
        details(index + 1);
      };
      const cached = task.side === "pr" && e.attempts.find(a => a.run.id === task.run.id && a.run.attempt === task.attempt && a.run.status === "completed" && a.complete);
      if (cached) consume({ value: cached, complete: true });
      else this.loadAttempt(e, task.run, task.attempt, consume, options);
    };
    const logs = (index: number, failures: Observation[]): void => {
      if (index >= failures.length) {
        const count = e.observations.filter(o => failed(o.job.conclusion)).length;
        if (count > 4) warn(`Only 4 of ${count} comparison failure logs examined.`);
        this.state.historyLoading = false; return this.changed(true);
      }
      const o = failures[index];
      this.github.log(e.repo, o.job.id, r => {
        o.excerpt = r.value ?? { text: "", truncated: false, error: r.error };
        if (!r.complete) warn(`Comparison job ${o.job.id}: ${r.error ?? "log truncated"}`);
        logs(index + 1, failures);
      }, options);
    };
    summaries(0);
  }
  prepare(jobId: number): void {
    const e = this.state.evidence;
    const job = e?.attempts.flatMap(a => a.jobs).find(j => j.id === jobId);
    if (!e || !job || this.state.historical || this.state.loading || this.state.historyLoading || ["verifying", "sending"].includes(this.state.dispatch?.phase ?? "")) return;
    this.state.selectedJob = jobId;
    const question = "What caused this CI failure, and does the comparison evidence support a regression or a recurring problem? Verify the tested commit before proposing a fix.";
    this.state.dispatch = { token: ++this.dispatchToken, job: jobId, text: brief(e, job, question), question, acknowledged: false, phase: "preview" };
    this.changed();
  }
  question(value: string): void {
    const d = this.state.dispatch, e = this.state.evidence, job = this.currentJob();
    if (!d || !e || !job || d.phase !== "preview") return;
    d.question = value.slice(0, 1000); d.text = brief(e, job, d.question, this.verificationText(d.verification)); this.changed();
  }
  acknowledge(): void { const d = this.state.dispatch; if (d?.phase === "preview" && d.verification) { d.acknowledged = true; this.changed(); } }
  selectSession(id: string): void {
    const d = this.state.dispatch;
    if (!d || d.phase !== "preview") return;
    d.token = ++this.dispatchToken; d.session = id; d.verification = undefined; d.acknowledged = false; d.phase = "verifying"; d.error = undefined; this.changed();
    this.verify(d, r => {
      if (r.error || !r.value) { d.phase = "preview"; d.error = r.error; return this.changed(); }
      d.verification = r.value; d.phase = "preview";
      const e = this.state.evidence!, job = e.attempts.flatMap(a => a.jobs).find(j => j.id === d.job)!;
      d.text = brief(e, job, d.question, this.verificationText(r.value)); this.changed();
    });
  }
  private verificationText(v?: Verification): string {
    return v ? `Verified worktree ${v.worktree} at ${v.sha}, repository ${v.repo}, ${new Date(v.at).toISOString()}. ${v.mismatch ? "Checkout differs from PR head; user acknowledgement required." : "Checkout matches PR head."} Verification is an observation, not an atomic lock on checkout.` : "Checkout verification pending";
  }
  private verify(d: Dispatch, done: (r: Result<Verification>) => void): void {
    const e = this.state.evidence;
    if (!e || !d.session) return;
    const token = d.token;
    const revision = this.snapshotRevision;
    const alive = () => this.state.dispatch === d && d.token === token && !this.state.historical;
    this.hooks.snapshot(snapshot => {
      if (!alive()) return;
      const worktree = snapshot.worktrees.find(w => w.sessions.some(s => s.id === d.session && !["detached", "failed", "unknown"].includes(s.state)));
      const newerOwner = this.state.snapshot.worktrees.find(w => w.sessions.some(s => s.id === d.session && !["detached", "failed", "unknown"].includes(s.state)));
      if (revision !== this.snapshotRevision && newerOwner?.id !== worktree?.id) return done({ error: "Workspace session ownership changed during verification. Prepare a new investigation.", complete: false });
      this.state.snapshot = snapshot;
      if (!worktree) return done({ error: "Selected session is unavailable. Choose a live chat session or copy the brief.", complete: false });
      this.queue.run("ci-remotes", worktree.id, [], remotes => {
        const error = processError(remotes);
        if (error || remotes.result?.truncated) return done({ error: "Cannot verify session repository. " + (error ?? "Remote output truncated."), complete: false });
        const repositories = remotes.result!.stdout.split("\n").map(remoteRepo).filter((v): v is string => !!v);
        const head = e.head.repo.toLowerCase(), base = e.repo.toLowerCase();
        const repo = repositories.includes(head) ? head : repositories.includes(base) ? base : undefined;
        if (!repo) return done({ error: "Selected session repository does not match the PR head or base repository. Branch names cannot verify ownership. Copy the brief.", complete: false });
        this.queue.run("ci-head", worktree.id, [], out => {
          const error = processError(out), sha = out.result?.stdout.trim();
          if (error || out.result?.truncated || !validSHA(sha)) return done({ error: "Cannot verify session checkout SHA. " + (error ?? "HEAD unavailable."), complete: false });
          done({ value: { worktree: worktree.id, sha, repo, at: this.hooks.now(), mismatch: sha !== e.head.sha || repo !== head }, complete: true });
        }, { alive, priority: true });
      }, { alive, priority: true });
    });
  }
  send(): void {
    const d = this.state.dispatch, e = this.state.evidence;
    if (!d || !e || d.phase !== "preview" || !d.session || !d.verification || this.state.historical || (d.verification.mismatch && !d.acknowledged)) return;
    d.phase = "verifying"; d.error = undefined; this.changed();
    const before = d.verification;
    const token = d.token;
    const options = { alive: () => this.state.dispatch === d && d.token === token && !this.state.historical && d.phase === "verifying", priority: true };
    const fail = (error: string) => { d.phase = "failed"; d.error = error + " No automatic retry. Copy the brief or prepare a new investigation."; this.changed(); };
    this.verify(d, r => {
      if (!r.value) return fail(r.error ?? "Session verification unavailable.");
      if (r.value.worktree !== before.worktree || r.value.sha !== before.sha || r.value.repo !== before.repo) return fail("Selected worktree checkout or repository changed since preview.");
      const verification = r.value;
      this.github.identity(e.repo, e.number, identity => {
        if (!identity.value || identity.value.sha !== e.head.sha || identity.value.repo !== e.head.repo || identity.value.baseSha !== e.head.baseSha) return fail(identity.error ?? "PR head/base changed since preview; refresh details.");
        const job = e.attempts.flatMap(a => a.jobs).find(j => j.id === d.job);
        const known = e.runs.find(run => run.id === job?.run);
        if (!job || !known) return fail("Selected run is unavailable.");
        this.github.run(e.repo, job.run, undefined, run => {
          if (!run.value || run.value.attempt !== known.attempt || run.value.sha !== known.sha || run.value.updated !== known.updated || run.value.status !== known.status) return fail(run.error ?? "Run or rerun attempt changed since preview; refresh details.");
          d.verification = verification;
          // Keep the reviewed prompt byte-for-byte. Fresh verification only confirms its identities.
          d.phase = "sending"; this.changed();
          this.hooks.send(d.session!, d.text, error => {
            if (this.state.dispatch !== d) return;
            d.phase = error ? "failed" : "sent";
            d.error = error ? `The host did not confirm acceptance: ${error}. Only live chat sessions take prompts; terminal-only sessions cannot. No automatic retry. The brief remains copyable.` : undefined;
            this.changed();
          });
        }, options);
      }, options);
    });
  }
}
