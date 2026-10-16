import type { Outcome, ProcessResult } from "@alas/plugin";
import { processError } from "./inbox.ts";
import { excerpt, parseIdentity, parseJobs, parseRun, parseRuns, type Excerpt, type Job, type PullIdentity, type Run } from "./doctor.ts";

type Done = (o: Outcome<ProcessResult>) => void;
type Driver = (id: string, worktree: string, args: string[], done: Done) => void;
interface Listener { done: Done; alive: () => boolean }
interface Task { key: string; id: string; worktree: string; args: string[]; listeners: Listener[]; priority: boolean; ready: () => boolean }
export interface RequestOptions { alive?: () => boolean; priority?: boolean; ready?: () => boolean }

/** The two-process limit belongs to the plugin instance, including its original list/merge. */
export class ProcessQueue {
  private waiting: Task[] = [];
  private shared = new Map<string, Task>();
  private active = 0;
  private draining = false;
  private githubReady = () => true;
  private driver: Driver;
  constructor(driver: Driver) { this.driver = driver; }
  run(id: string, worktree: string, args: string[], done: Done, options: RequestOptions = {}): void {
    const key = JSON.stringify([id, worktree, args]);
    const listener = { done, alive: options.alive ?? (() => true) };
    const existing = this.shared.get(key);
    if (existing) { existing.listeners.push(listener); existing.priority ||= !!options.priority; return; }
    const task: Task = { key, id, worktree, args, listeners: [listener], priority: !!options.priority, ready: options.ready ?? (() => true) };
    this.shared.set(key, task);
    this.waiting.push(task);
    this.drain();
  }
  resume(): void { this.drain(); }
  setGitHubGate(ready: () => boolean): void { this.githubReady = ready; }
  private ready(task: Task): boolean { return task.ready() && (!["list", "merge", "ci-api"].includes(task.id) || this.githubReady()); }
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < 2 && this.waiting.length) {
        this.waiting = this.waiting.filter(task => {
          task.listeners = task.listeners.filter(l => l.alive());
          if (!task.listeners.length) this.shared.delete(task.key);
          return task.listeners.length > 0;
        });
        const high = this.waiting.findIndex(t => t.priority && this.ready(t));
        const index = high < 0 ? this.waiting.findIndex(t => this.ready(t)) : high;
        if (index < 0) break;
        const task = this.waiting.splice(index, 1)[0];
        this.active++;
        this.driver(task.id, task.worktree, task.args, outcome => {
          this.active--;
          this.shared.delete(task.key);
          for (const listener of task.listeners) if (listener.alive()) listener.done(outcome);
          this.drain();
        });
      }
    } finally { this.draining = false; }
  }
}
export interface Result<T> { value?: T; error?: string; complete: boolean; warning?: string }
const RUN_FIELDS = "{id,workflow_id,name,run_attempt,head_sha,head_branch,event,status,conclusion,created_at,updated_at,html_url,pull_requests:[.pull_requests[]?|{number}],head_repository:{full_name:.head_repository.full_name}}";
const JOB_FIELDS = "{id,run_id,run_attempt,name,status,conclusion,started_at,completed_at,html_url,steps:[.steps[]?|{number,name,status,conclusion}]}";
/** Strip gh --include headers, including any redirects, without treating log text as headers. */
function response(stdout: string): { body: string; headers: string } {
  let body = stdout, headers = "";
  while (/^HTTP\/\S+ \d{3}/.test(body)) {
    const match = /\r?\n\r?\n/.exec(body);
    if (!match) break;
    const end = match.index + match[0].length;
    headers += body.slice(0, end);
    body = body.slice(end);
  }
  return { body, headers };
}

export class GitHub {
  blockedUntil = 0;
  authBlocked = false;
  private queue: ProcessQueue;
  readonly worktree: string;
  private now: () => number;
  private backoff: (seconds: number) => void;
  constructor(queue: ProcessQueue, worktree: string, now: () => number, backoff: (seconds: number) => void) {
    this.queue = queue; this.worktree = worktree; this.now = now; this.backoff = backoff;
    this.queue.setGitHubGate(() => !this.authBlocked && this.now() >= this.blockedUntil);
  }
  retry(): void { this.authBlocked = false; this.queue.resume(); }
  /** Original list/merge share this error gate even though their response is not REST JSON. */
  observe(outcome: Outcome<ProcessResult>): void {
    if (!processError(outcome)) return;
    const parsed = response(outcome.result?.stdout ?? "");
    const message = `${outcome.result?.stderr ?? ""}\n${parsed.body}\n${processError(outcome)}`;
    if (/rate limit|secondary rate|abuse detection/i.test(message) || /^HTTP\/\S+ 429/m.test(parsed.headers)) {
      const retry = /retry-after:\s*(\d+)/i.exec(parsed.headers);
      const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(parsed.headers);
      const delay = retry ? Number(retry[1]) * 1000 : reset ? Math.max(60000, Number(reset[1]) * 1000 - this.now()) : 60000;
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(1000, delay));
      this.backoff(Math.max(1, Math.ceil((this.blockedUntil - this.now()) / 1000)));
    }
    if (/gh auth login|bad credentials|HTTP 401|not logged/i.test(message)) this.authBlocked = true;
  }
  json(path: string, done: (r: Result<any>) => void, options: RequestOptions = {}, projection?: string): void {
    this.request(path, false, done, options, projection);
  }
  private request(path: string, raw: boolean, done: (r: Result<any>) => void, options: RequestOptions, projection?: string, allowEscapes = false): void {
    if (this.authBlocked) return done({ error: "Sign in with gh auth login on this execution host, then Retry.", complete: false });
    if (this.now() < this.blockedUntil) return done({ error: `GitHub rate limited. Retry after ${new Date(this.blockedUntil).toISOString()}.`, complete: false });
    const args = [path, "--method", "GET", "--include", ...(allowEscapes ? ["--allow-escape-sequences"] : []), ...(projection ? ["--jq", projection] : [])];
    this.queue.run("ci-api", this.worktree, args, outcome => {
      const out = outcome.result;
      const parsed = response(out?.stdout ?? "");
      const error = processError(outcome);
      // Recent gh protects terminals from raw log escapes. Older gh needs no flag.
      // Only retry its specific refusal; excerpt() strips control sequences before rendering.
      if (raw && !allowEscapes && error && /response contains terminal escape sequences.*--allow-escape-sequences/s.test(out?.stderr ?? "")) return this.request(path, raw, done, options, projection, true);
      this.observe(outcome);
      if (error) {
        const message = `${out?.stderr ?? ""}\n${parsed.body}\n${error}`;
        const logMissing = raw && /HTTP 404|HTTP 410|not found|expired/i.test(message);
        return done({ error: logMissing ? "Logs unavailable or expired (GitHub 404/410)." : error, complete: false });
      }
      if (!raw && out?.truncated) return done({ error: "GitHub JSON output was truncated; evidence is incomplete.", complete: false });
      if (raw) return done({ value: { ...excerpt(parsed.body, !!out?.truncated), fetchedAt: this.now() }, complete: !out?.truncated });
      let value: unknown;
      try { value = JSON.parse(parsed.body); }
      catch { return done({ error: "GitHub returned malformed JSON; evidence is unavailable.", complete: false }); }
      done({ value, complete: true });
    }, { ...options, ready: () => !this.authBlocked && this.now() >= this.blockedUntil });
  }
  identity(repo: string, number: number, done: (r: Result<PullIdentity>) => void, options: RequestOptions = {}): void {
    this.json(`repos/${repo}/pulls/${number}`, r => this.normalize(r, parseIdentity, done), options, "{head:{sha:.head.sha,ref:.head.ref,repo:{full_name:.head.repo.full_name}},base:{sha:.base.sha,ref:.base.ref}}");
  }
  run(repo: string, id: number, attempt: number | undefined, done: (r: Result<Run>) => void, options: RequestOptions = {}): void {
    this.json(`repos/${repo}/actions/runs/${id}${attempt ? `/attempts/${attempt}` : ""}`, r => this.normalize(r, parseRun, done), options, RUN_FIELDS);
  }
  runs(repo: string, filter: { branch?: string; workflow?: number; since?: string; until?: string }, done: (r: Result<Run[]>) => void, options: RequestOptions = {}): void {
    const collected: Run[] = [];
    const next = (page: number) => {
      const query = `per_page=10&page=${page}${filter.branch !== undefined ? `&branch=${encodeURIComponent(filter.branch)}` : ""}${filter.since ? `&created=${encodeURIComponent(filter.until ? `${filter.since}..${filter.until}` : ">=" + filter.since)}` : ""}`;
      const path = `repos/${repo}/actions/${filter.workflow ? `workflows/${filter.workflow}/runs` : "runs"}?${query}`;
      this.json(path, r => {
        if (r.error) return done({ value: collected, error: r.error, complete: false });
        let values: Run[];
        try { values = parseRuns(r.value); } catch (e) { return done({ value: collected, error: String(e), complete: false }); }
        collected.push(...values);
        const more = values.length === 10 && (typeof r.value?.total_count !== "number" || collected.length < r.value.total_count);
        if (more && page < 3) return next(page + 1);
        done({ value: collected, complete: !more, warning: more ? "Run history incomplete: stopped at 30 summaries." : undefined });
      }, options, `{total_count,workflow_runs:[.workflow_runs[]|${RUN_FIELDS}]}`);
    };
    next(1);
  }
  jobs(repo: string, id: number, attempt: number, done: (r: Result<Job[]>) => void, options: RequestOptions = {}): void {
    const collected: Job[] = [];
    const next = (page: number) => this.json(`repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=25&page=${page}`, r => {
      if (r.error) return done({ value: collected, error: r.error, complete: false });
      let jobs: Job[];
      try { jobs = parseJobs(r.value, id, attempt); } catch (e) { return done({ value: collected, error: String(e), complete: false }); }
      collected.push(...jobs);
      const more = jobs.length === 25 && (typeof r.value?.total_count !== "number" || collected.length < r.value.total_count);
      if (more && page < 4) return next(page + 1);
      done({ value: collected, complete: !more, warning: more ? "Jobs incomplete: stopped at 100 jobs." : undefined });
    }, options, `{total_count,jobs:[.jobs[]|${JOB_FIELDS}]}`);
    next(1);
  }
  log(repo: string, job: number, done: (r: Result<Excerpt>) => void, options: RequestOptions = {}): void {
    this.request(`repos/${repo}/actions/jobs/${job}/logs`, true, done, options);
  }
  private normalize<T>(r: Result<any>, parse: (v: unknown) => T, done: (r: Result<T>) => void): void {
    if (r.error) return done({ error: r.error, complete: false });
    let value: T;
    try { value = parse(r.value); }
    catch (e) { return done({ error: String(e), complete: false }); }
    done({ value, complete: r.complete });
  }
}
