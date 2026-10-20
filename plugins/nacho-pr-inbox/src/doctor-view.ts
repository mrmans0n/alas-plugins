import type { DoctorState } from "./doctor-controller.ts";
import { attemptKey, attemptNumbers, classifyEvidence, failed, statusLabel } from "./doctor.ts";
import type { Tone } from "./view.ts";

export interface Note { text: string; tone?: Tone }
export interface Option { id: string; label: string }
/** One past result of the selected job: passed, failed, or anything else. */
export type Outcome = "pass" | "fail" | "other";

export interface JobModel {
  id: number; name: string; status: string; failed: boolean; time: string; url: string;
  notes: Note[]; steps: string[]; selected: boolean;
}

export interface EvidenceModel {
  job: number; title: string; notes: Note[]; excerpt: string; comparing: boolean;
  suggestion: { kind: string; text: string; links: string[] };
  observations: { text: string; url: string }[];
  /** The selected job's comparable runs, oldest first, per side. */
  history: { pr: Outcome[]; base: Outcome[] };
  canPrepare: boolean;
}

export interface DispatchModel {
  token: number; brief: string; question: string; sessions: Option[]; session?: string; notes: Note[];
  verification?: string; mismatch: boolean; canAcknowledge: boolean; acknowledged: boolean;
  progress?: string; sent: boolean; canSend: boolean;
}

export interface DoctorModel {
  number: number; title: string; url?: string; loading: boolean; busy: boolean;
  /** Comparing history: jobs wait to be picked until it finishes. */
  historyLoading: boolean;
  error?: string; unavailable?: string;
  head?: string; base?: string; notes: Note[];
  runs: Option[]; run?: string; attempts: Option[]; attempt?: string; runNotes: Note[];
  jobs: JobModel[]; evidence?: EvidenceModel; dispatch?: DispatchModel;
}

const outcome = (conclusion: string | null): Outcome => (conclusion === "success" ? "pass" : failed(conclusion) ? "fail" : "other");
const iso = (ms: number) => new Date(ms).toISOString();

/** What the page draws for CI Doctor, in the tab and the rail alike. GitHub data stays plain text. */
export function doctorModel(state: DoctorState): DoctorModel {
  const pull = state.target!.pull;
  const e = state.evidence;
  const model: DoctorModel = {
    number: pull.number, title: e?.title ?? pull.title, url: e?.url ?? pull.url, loading: state.loading,
    busy: state.loading || state.historyLoading, historyLoading: state.historyLoading, ...(state.error ? { error: state.error } : {}),
    notes: [], runs: [], attempts: [], runNotes: [], jobs: [],
  };
  if (!e) return { ...model, unavailable: state.loading ? "Fetching PR identity…" : "Evidence unavailable. Retry after checking gh on the owning host." };
  model.head = `PR head ${e.head.repo}@${e.head.sha}`;
  model.base = `Base ${e.head.baseBranch}@${e.head.baseSha}`;
  model.notes.push({ text: `${state.cached ? "Cached evidence" : "Evidence fetched"} ${iso(e.fetchedAt)}`, tone: "dim" });
  if (state.historical) model.notes.push({ text: "Historical evidence: the PR changed or left this inbox. Refresh before investigating the current head.", tone: "warn" });
  model.notes.push(
    { text: `Observation window: ${e.since} through ${e.until}`, tone: "dim" },
    { text: "Bounded sample: 30 summaries, 5 comparison runs per side, 5 attempts/run, 100 jobs/attempt, 4 comparison logs. Absence is not proof of success.", tone: "dim" },
    ...e.coverage.slice(0, 50).map((text) => ({ text, tone: "warn" as Tone })),
  );
  if (!e.runs.length) model.notes.push({ text: "No associated Actions runs available in this bounded window. Other CI providers are not included.", tone: "dim" });

  const selected = e.attempts.find((a) => attemptKey(a.run.id, a.run.attempt) === state.selectedAttempt);
  const run = e.runs.find((r) => r.id === selected?.run.id) ?? e.runs[0];
  if (run) {
    model.runs = e.runs.slice(0, 30).map((r) => ({ id: String(r.id), label: `${r.name} · run ${r.id} · ${statusLabel(r)} · ${r.sha.slice(0, 12)}` }));
    model.run = String(run.id);
    model.attempts = attemptNumbers(run.attempt).map((n) => {
      const a = e.attempts.find((a) => a.run.id === run.id && a.run.attempt === n);
      return { id: String(n), label: `Attempt ${n} · ${a ? statusLabel(a.run) : "not loaded"}` };
    });
    model.attempt = String(selected?.run.attempt ?? run.attempt);
    if (run.attempt > 5) model.runNotes.push({ text: `Attempts 2 through ${run.attempt - 4} omitted by the five-attempt bound.`, tone: "warn" });
  }
  if (!selected) return model;

  const r = selected.run;
  model.runNotes.push(
    { text: `${r.name} · run ${r.id} · attempt ${r.attempt} · ${statusLabel(r)}` },
    { text: `Recorded run SHA ${r.sha} · ref ${r.branch} · event ${r.event}. A PR workflow may test a synthetic merge or custom checkout; the run SHA is not checkout proof.`, tone: "dim" },
    { text: `Created ${r.created || "unknown"} · updated ${r.updated || "unknown"}`, tone: "dim" },
  );
  if (r.sha !== e.head.sha) model.runNotes.push({ text: "This run's recorded SHA differs from the current PR head. Treat it as historical or a distinct tested ref.", tone: "warn" });
  if (!selected.complete) model.runNotes.push({ text: selected.error ?? "Jobs incomplete or unavailable.", tone: "warn" });
  if (!selected.jobs.length) model.runNotes.push({ text: "No jobs available for this attempt.", tone: "dim" });
  model.jobs = selected.jobs.map((j) => {
    const failures = j.steps.filter((s) => failed(s.conclusion));
    return {
      id: j.id, name: j.name, status: statusLabel(j), failed: failed(j.conclusion), url: j.url, selected: j.id === state.selectedJob,
      time: `${j.started || "Start unknown"} → ${j.completed || "Not completed"}`,
      notes: selected.cachedJobs?.includes(j.id) ? [{ text: `Cached job observation${selected.fetchedAt ? " from " + iso(selected.fetchedAt) : ""}; live refresh incomplete.`, tone: "warn" }] : [],
      steps: [
        ...failures.slice(0, 5).map((s) => `Step ${s.number}: ${s.name} · ${statusLabel(s)}`),
        ...(failures.length > 5 ? [`${failures.length - 5} failed steps omitted here; open the job on GitHub for all steps.`] : []),
      ],
    };
  });

  const job = selected.jobs.find((j) => j.id === state.selectedJob);
  if (job) {
    const log = e.logs[String(job.id)];
    const notes: Note[] = [];
    if (log?.error) notes.push({ text: log.error, tone: "warn" });
    if (log?.fetchedAt) notes.push({ text: `Log fetched ${iso(log.fetchedAt)}`, tone: "dim" });
    notes.push({ text: `Tested checkout observed in log: ${log?.checkout ?? "unknown"}. This is a log observation only.`, tone: "dim" });
    if (log?.truncated) notes.push({ text: "Bounded excerpt: lines or bytes were omitted. Host output may also be truncated; the missing tail was not searched.", tone: "warn" });
    const same = e.observations.filter((o) => o.job.name === job.name).sort((a, b) => (a.run.created < b.run.created ? -1 : a.run.created > b.run.created ? 1 : 0));
    model.evidence = {
      job: job.id, title: `Failure evidence · ${job.name}`, notes, excerpt: log?.text || "Logs unavailable or still loading.",
      comparing: state.historyLoading,
      suggestion: state.historyLoading ? { kind: "unknown", text: "Comparison in progress; classification is pending until the bounded sample finishes.", links: [job.url] } : classifyEvidence(e, job),
      observations: e.observations.map((o) => ({ text: `${o.side} · ${o.run.name} · ${o.job.name} · ${o.run.sha} · run ${o.run.id} · attempt ${o.job.attempt} · ${statusLabel(o.job)}`, url: o.job.url })),
      history: { pr: same.filter((o) => o.side === "pr").map((o) => outcome(o.job.conclusion)), base: same.filter((o) => o.side === "base").map((o) => outcome(o.job.conclusion)) },
      canPrepare: !(state.historical || state.loading || state.historyLoading || ["verifying", "sending"].includes(state.dispatch?.phase ?? "")),
    };
  }

  const d = state.dispatch;
  if (d) {
    const candidates = state.snapshot.worktrees.flatMap((w) => w.sessions.filter((s) => /^[A-Za-z0-9_-]{1,48}$/.test(s.id) && !["detached", "failed", "unknown"].includes(s.state)).map((s) => ({ id: s.id, label: `${w.branch} · ${s.title} · ${s.agent} · ${s.state}` })));
    const notes: Note[] = [{ text: "Choose a session explicitly. The host checks live chat availability on send; terminal-only sessions are refused.", tone: "dim" }];
    if (!candidates.length) notes.push({ text: "No live session candidates. Open a chat in the correct repository worktree, or copy the brief.", tone: "warn" });
    if (candidates.length > 64) notes.push({ text: "Only the first 64 session candidates are shown.", tone: "warn" });
    const v = d.verification;
    model.dispatch = {
      token: d.token, brief: d.text, question: d.question, sessions: candidates.slice(0, 64), ...(d.session ? { session: d.session } : {}), notes,
      ...(v ? { verification: `Verified ${v.repo} · worktree ${v.worktree} · HEAD ${v.sha} · checked ${iso(v.at)}` } : {}),
      mismatch: !!v?.mismatch, acknowledged: d.acknowledged, canAcknowledge: !!v?.mismatch && !d.acknowledged && d.phase === "preview",
      ...(d.error ? { notes: [...notes, { text: d.error, tone: "warn" as Tone }] } : {}),
      ...(d.phase === "verifying" || d.phase === "sending" ? { progress: d.phase === "verifying" ? "Verifying session and current identities…" : "Waiting for the host to accept the prompt. Do not resend." } : {}),
      sent: d.phase === "sent",
      canSend: !(d.phase !== "preview" || !d.session || !v || (v.mismatch && !d.acknowledged) || state.historical),
    };
  }
  return model;
}
