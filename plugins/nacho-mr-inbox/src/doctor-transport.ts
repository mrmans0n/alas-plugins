import type { Outcome, ProcessResult } from "@alas/plugin";
import { processError } from "./inbox.ts";
import { excerpt, parseIdentity, parseJobs, parsePipeline, parsePipelines, type Excerpt, type Job, type PullIdentity, type Run } from "./doctor.ts";

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
  private gateReady = () => true;
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
  setGate(ready: () => boolean): void { this.gateReady = ready; }
  private ready(task: Task): boolean { return task.ready() && (!["list", "project", "add", "automerge", "retry", "ci-api", "ci-trace"].includes(task.id) || this.gateReady()); }
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
/** Strip glab --include headers, including any redirects, without treating log text as headers. */
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

export const endpoint = (project: string, rest: string) => `projects/${encodeURIComponent(project)}/${rest}`;

export class GitLab {
  blockedUntil = 0;
  authBlocked = false;
  private queue: ProcessQueue;
  readonly worktree: string;
  readonly project: string;
  readonly host: string;
  private now: () => number;
  private backoff: (seconds: number) => void;
  constructor(queue: ProcessQueue, worktree: string, project: string, host: string, now: () => number, backoff: (seconds: number) => void) {
    this.queue = queue; this.worktree = worktree; this.project = project; this.host = host; this.now = now; this.backoff = backoff;
    this.queue.setGate(() => !this.authBlocked && this.now() >= this.blockedUntil);
  }
  retry(): void { this.authBlocked = false; this.queue.resume(); }
  observe(outcome: Outcome<ProcessResult>): void {
    if (!processError(outcome)) return;
    const parsed = response(outcome.result?.stdout ?? "");
    const message = `${outcome.result?.stderr ?? ""}\n${parsed.body}\n${processError(outcome)}`;
    if (/(?:HTTP\/\S+ |: )429\b|rate limit|too many requests/i.test(message) || /^HTTP\/\S+ 429/m.test(parsed.headers)) {
      const retry = /retry-after:\s*(\d+)/i.exec(parsed.headers);
      const reset = /ratelimit-reset:\s*(\d+)/i.exec(parsed.headers);
      const delay = retry ? Number(retry[1]) * 1000 : reset ? Math.max(60000, Number(reset[1]) * 1000 - this.now()) : 60000;
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(1000, delay));
      this.backoff(Math.max(1, Math.ceil((this.blockedUntil - this.now()) / 1000)));
    }
    if (/401 Unauthorized|glab auth login|no token found/i.test(message)) this.authBlocked = true;
  }
  private gateError(): string | undefined {
    if (this.authBlocked) return "Sign in with glab auth login on this execution host, then Retry.";
    if (this.now() < this.blockedUntil) return `GitLab rate limited. Retry after ${new Date(this.blockedUntil).toISOString()}.`;
    return undefined;
  }
  private ready = () => !this.authBlocked && this.now() >= this.blockedUntil;
  json(rest: string, done: (r: Result<any>) => void, options: RequestOptions = {}): void {
    const blocked = this.gateError();
    if (blocked) return done({ error: blocked, complete: false });
    this.queue.run("ci-api", this.worktree, [endpoint(this.project, rest)], outcome => {
      this.observe(outcome);
      const error = processError(outcome);
      if (error) return done({ error, complete: false });
      if (outcome.result?.truncated) return done({ error: "GitLab JSON output was truncated; evidence is incomplete.", complete: false });
      let value: unknown;
      try { value = JSON.parse(response(outcome.result!.stdout).body); }
      catch { return done({ error: "GitLab returned malformed JSON; evidence is unavailable.", complete: false }); }
      done({ value, complete: true });
    }, { ...options, ready: this.ready });
  }
  identity(iid: number, done: (r: Result<PullIdentity>) => void, options: RequestOptions = {}): void {
    this.json(`merge_requests/${iid}`, r => this.normalize(r, v => parseIdentity(v, this.project), done), options);
  }
  run(id: number, done: (r: Result<Run>) => void, options: RequestOptions = {}): void {
    this.json(`pipelines/${id}`, r => this.normalize(r, v => parsePipeline(v, this.host, this.project), done), options);
  }
  runs(filter: { mr?: number; ref?: string; since: string }, done: (r: Result<Run[]>) => void, options: RequestOptions = {}): void {
    const collected: Run[] = [];
    const next = (page: number) => {
      const rest = filter.mr !== undefined
        ? `merge_requests/${filter.mr}/pipelines?per_page=10&page=${page}`
        : `pipelines?ref=${encodeURIComponent(filter.ref ?? "")}&source=push&updated_after=${encodeURIComponent(filter.since)}&per_page=10&page=${page}`;
      this.json(rest, r => {
        if (r.error) return done({ value: collected, error: r.error, complete: false });
        let values: Run[];
        try { values = parsePipelines(r.value, this.host, this.project); } catch (e) { return done({ value: collected, error: String(e), complete: false }); }
        collected.push(...values.filter(v => v.created >= filter.since));
        const more = values.length === 10;
        if (more && page < 3) return next(page + 1);
        done({ value: collected, complete: !more, warning: more ? "Pipeline history incomplete: stopped at 30 summaries." : undefined });
      }, options);
    };
    next(1);
  }
  jobs(pipeline: number, done: (r: Result<Job[]>) => void, options: RequestOptions = {}): void {
    const collected: Job[] = [];
    const next = (page: number) => this.json(`pipelines/${pipeline}/jobs?include_retried=true&per_page=25&page=${page}`, r => {
      if (r.error) return done({ value: collected, error: r.error, complete: false });
      let jobs: Job[];
      try { jobs = parseJobs(r.value, pipeline, this.host); } catch (e) { return done({ value: collected, error: String(e), complete: false }); }
      collected.push(...jobs);
      const more = jobs.length === 25;
      if (more && page < 4) return next(page + 1);
      // Attempt numbers count retries across pages, so recount once everything is in.
      for (const j of collected) j.attempt = collected.filter(o => o.name === j.name && o.id < j.id).length + 1;
      done({ value: collected, complete: !more, warning: more ? "Jobs incomplete: stopped at 100 jobs." : undefined });
    }, options);
    next(1);
  }
  log(job: number, done: (r: Result<Excerpt>) => void, options: RequestOptions = {}): void {
    const blocked = this.gateError();
    if (blocked) return done({ error: blocked, complete: false });
    this.queue.run("ci-trace", this.worktree, [String(job)], outcome => {
      this.observe(outcome);
      const error = processError(outcome);
      if (error) return done({ error: /\b(?:404|410)\b|not found/i.test(error) ? "Logs unavailable or expired (GitLab 404)." : error, complete: false });
      const out = outcome.result!;
      const headCut = out.truncated || out.stdout.length >= 262144;
      done({ value: { ...excerpt(out.stdout, headCut), fetchedAt: this.now() }, complete: !out.truncated });
    }, { ...options, ready: this.ready });
  }
  retryJob(id: number, done: (error?: string) => void): void { this.write(`jobs/${id}/retry`, done); }
  retryPipeline(id: number, done: (error?: string) => void): void { this.write(`pipelines/${id}/retry`, done); }
  private write(rest: string, done: (error?: string) => void): void {
    this.queue.run("retry", this.worktree, [endpoint(this.project, rest)], outcome => { this.observe(outcome); done(processError(outcome)); }, { priority: true });
  }
  private normalize<T>(r: Result<any>, parse: (v: unknown) => T, done: (r: Result<T>) => void): void {
    if (r.error) return done({ error: r.error, complete: false });
    let value: T;
    try { value = parse(r.value); }
    catch (e) { return done({ error: String(e), complete: false }); }
    done({ value, complete: r.complete });
  }
}
