import type { Node, Tone } from "@alas/plugin";
import type { DoctorState } from "./doctor-controller.ts";
import { attemptKey, attemptNumbers, classifyEvidence, cut, failed, literal, statusLabel } from "./doctor.ts";

const safe = (value: string) => [...value].slice(0, 3900).join("");
const text = (id: string, value: string, tone?: Tone): Node => ({ kind: "text", id, text: safe(value), style: "caption", tone });
const button = (id: string, label: string, disabled = false): Node => ({ kind: "button", id, label, disabled });
/** Fences cannot be closed by log data. Chunk to fit even pathological backtick/tilde runs. */
function quoted(id: string, value: string): Node[] {
  const out: Node[] = [];
  let remaining = value;
  while (remaining && out.length < 4) {
    const part = cut(remaining, 8 * 1024);
    out.push({ kind: "markdown", id: `${id}-${out.length}`, text: literal(part) });
    remaining = remaining.slice(part.length);
  }
  return out.length ? out : [text(id, "Unavailable", "dim")];
}

/** Same evidence and selection in the tab and the narrow rail. */
export function doctorView(state: DoctorState, compact = false): Node {
  const e = state.evidence;
  const contents: Node[] = [
    { kind: "hstack", id: "ci-header", spacing: 8, children: [button("ci-back", "Back"), text("ci-title", "CI Doctor"), { kind: "spacer", id: "ci-spacer" }, button("ci-refresh", "Refresh", state.loading || state.historyLoading)] },
    ...(state.loading ? [{ kind: "progress", id: "ci-loading", text: "Loading evidence…" } as Node] : []),
    ...(state.error ? [text("ci-error", state.error, "danger")] : []),
  ];
  if (!e) {
    contents.push(text("ci-unavailable", state.loading ? "Fetching PR identity…" : "Evidence unavailable. Retry after checking gh on the owning host.", "dim"));
    return { kind: "vstack", id: "ci-root", spacing: 8, children: contents };
  }
  const detail: Node[] = [
    text("ci-pr", `${e.repo} #${e.number} · ${e.title}`),
    { kind: "link", id: "ci-pr-link", label: "Open pull request", url: e.url },
    text("ci-head", `PR head: ${e.head.repo}@${e.head.sha}`),
    text("ci-base", `Base: ${e.head.baseBranch}@${e.head.baseSha}`),
    text("ci-age", `${state.cached ? "Cached evidence" : "Evidence fetched"}: ${new Date(e.fetchedAt).toISOString()}`, "dim"),
    ...(state.historical ? [text("ci-historical", "Historical evidence: the PR changed or left this inbox. Refresh before investigating the current head.", "warn")] : []),
    text("ci-window", `Observation window: ${e.since} through ${e.until}`, "dim"),
    text("ci-bounds", "Bounded sample: 30 summaries, 5 comparison runs per side, 5 attempts/run, 100 jobs/attempt, 4 comparison logs. Absence is not proof of success.", "dim"),
    ...e.coverage.slice(0, 50).map((c, i) => text(`ci-coverage-${i}`, c, "warn")),
  ];
  if (!e.runs.length) detail.push(text("ci-no-runs", "No associated Actions runs available in this bounded window. Other CI providers are not included.", "dim"));
  const selected = e.attempts.find(a => attemptKey(a.run.id, a.run.attempt) === state.selectedAttempt);
  const run = e.runs.find(r => r.id === selected?.run.id) ?? e.runs[0];
  if (run) {
    detail.push({ kind: "menu", id: "ci-runs", label: `Workflow/run: ${safe(run.name).slice(0, 120)} · ${run.id}`, items: e.runs.slice(0, 30).map(r => ({ id: String(r.id), label: safe(`${r.name} · run ${r.id} · ${statusLabel(r)} · ${r.sha.slice(0, 12)}`) })) });
    detail.push({ kind: "menu", id: `ci-attempts-${run.id}`, label: `Attempt ${selected?.run.attempt ?? run.attempt}`, items: attemptNumbers(run.attempt).map(n => {
      const a = e.attempts.find(a => a.run.id === run.id && a.run.attempt === n);
      return { id: String(n), label: `Attempt ${n} · ${a ? statusLabel(a.run) : "not loaded"}` };
    }) });
    if (run.attempt > 5) detail.push(text("ci-attempt-bound", `Attempts 2 through ${run.attempt - 4} omitted by the five-attempt bound.`, "warn"));
  }
  if (selected) {
    const r = selected.run;
    detail.push(
      text("ci-run-status", `${r.name} · run ${r.id} · attempt ${r.attempt} · ${statusLabel(r)}`),
      text("ci-run-sha", `Recorded run SHA: ${r.sha}\nRef: ${r.branch} · event: ${r.event}\nA PR workflow may test a synthetic merge or custom checkout. The run SHA is not checkout proof.`),
      text("ci-run-time", `Created ${r.created || "unknown"} · updated ${r.updated || "unknown"}`, "dim"),
      { kind: "link", id: "ci-run-link", label: "Open run attempt", url: `${r.url}/attempts/${r.attempt}` },
    );
    if (r.sha !== e.head.sha) detail.push(text("ci-run-historical", "This run's recorded SHA differs from the current PR head. Treat it as historical or a distinct tested ref.", "warn"));
    if (!selected.complete) detail.push(text("ci-jobs-incomplete", selected.error ?? "Jobs incomplete or unavailable.", "warn"));
    if (!selected.jobs.length) detail.push(text("ci-no-jobs", "No jobs available for this attempt.", "dim"));
    for (const j of selected.jobs) {
      const failures = j.steps.filter(s => failed(s.conclusion));
      detail.push({ kind: "vstack", id: `ci-job-${j.id}`, spacing: 4, children: [
        text(`ci-job-name-${j.id}`, `${j.name} · ${statusLabel(j)}`, failed(j.conclusion) ? "danger" : "dim"),
        ...(selected.cachedJobs?.includes(j.id) ? [text(`ci-job-cached-${j.id}`, `Cached job observation${selected.fetchedAt ? " from " + new Date(selected.fetchedAt).toISOString() : ""}; live refresh incomplete.`, "warn")] : []),
        text(`ci-job-time-${j.id}`, `${j.started || "Start unknown"} → ${j.completed || "Not completed"}`, "dim"),
        ...failures.slice(0, 5).map(s => text(`ci-step-${j.id}-${s.number}`, `Step ${s.number}: ${s.name} · ${statusLabel(s)}`, "danger")),
        ...(failures.length > 5 ? [text(`ci-steps-omitted-${j.id}`, `${failures.length - 5} failed steps omitted here; open the job on GitHub for all steps.`, "warn")] : []),
        { kind: "hstack", id: `ci-job-actions-${j.id}`, spacing: 6, children: [
          { kind: "link", id: `ci-job-link-${j.id}`, label: "Open job", url: j.url },
          button(`ci-job-open-${j.id}`, "Evidence", state.historyLoading),
        ] },
      ] });
    }
    const job = selected.jobs.find(j => j.id === state.selectedJob);
    if (job) {
      const log = e.logs[String(job.id)];
      detail.push({ kind: "divider", id: "ci-evidence-divider" }, text("ci-evidence-title", `Failure evidence · ${job.name}`));
      if (log?.error) detail.push(text("ci-log-error", log.error, "warn"));
      if (log?.fetchedAt) detail.push(text("ci-log-time", `Log fetched ${new Date(log.fetchedAt).toISOString()}`, "dim"));
      detail.push(text("ci-checkout", `Tested checkout observed in log: ${log?.checkout ?? "unknown"}. This is a log observation only.`, "dim"));
      if (log?.truncated) detail.push(text("ci-log-truncated", "Bounded excerpt: lines or bytes were omitted. Host output may also be truncated; the missing tail was not searched.", "warn"));
      detail.push(...quoted("ci-excerpt", log?.text || "Logs unavailable or still loading."));
      if (state.historyLoading) detail.push({ kind: "progress", id: "ci-history-loading", text: "Comparing bounded PR/base history…" });
      const suggestion = state.historyLoading ? { kind: "unknown", text: "Comparison in progress; classification is pending until the bounded sample finishes.", links: [job.url] } : classifyEvidence(e, job);
      detail.push(text("ci-suggestion", `${suggestion.kind}: ${suggestion.text}`));
      suggestion.links.forEach((url, i) => detail.push({ kind: "link", id: `ci-support-${i}`, label: `Supporting job ${i + 1}`, url }));
      for (const [i, o] of e.observations.entries()) detail.push({ kind: "vstack", id: `ci-observation-${i}`, spacing: 3, children: [text(`ci-observation-text-${i}`, `${o.side} · ${o.run.name} · ${o.job.name}\n${o.run.sha} · run ${o.run.id} · attempt ${o.job.attempt} · ${statusLabel(o.job)}`), { kind: "link", id: `ci-observation-link-${i}`, label: "Comparison job", url: o.job.url }] });
      detail.push(button(`ci-prepare-${job.id}`, "Investigate…", state.historical || state.loading || state.historyLoading || ["verifying", "sending"].includes(state.dispatch?.phase ?? "")));
    }
  }
  const d = state.dispatch;
  if (d) {
    detail.push({ kind: "divider", id: "ci-dispatch-divider" }, text("ci-preview-title", "Review investigation brief"), ...quoted("ci-brief", d.text));
    detail.push({ kind: "textField", id: `ci-question-${d.token}`, value: safe(d.question), placeholder: "Investigation question", multiline: true });
    detail.push(text("ci-question-help", "Command-Return applies the question to the brief. Select the brief text to copy it.", "dim"));
    const candidates = state.snapshot.worktrees.flatMap(w => w.sessions.filter(s => /^[A-Za-z0-9_-]{1,48}$/.test(s.id) && !["detached", "failed", "unknown"].includes(s.state)).map(s => ({ id: s.id, label: safe(`${w.branch} · ${s.title} · ${s.agent} · ${s.state}`) })));
    detail.push(text("ci-session-help", "Choose a session explicitly. The host checks live chat availability on send; terminal-only sessions are refused.", "dim"));
    if (candidates.length) detail.push({ kind: "menu", id: `ci-sessions-${d.token}`, label: d.session ? `Session: ${d.session}` : "Select a session…", items: candidates.slice(0, 64) });
    else detail.push(text("ci-no-sessions", "No live session candidates. Open a chat in the correct repository worktree, or copy the brief.", "warn"));
    if (candidates.length > 64) detail.push(text("ci-session-bound", "Only the first 64 session candidates are shown.", "warn"));
    if (d.verification) {
      detail.push(text("ci-verified", `Verified ${d.verification.repo} · worktree ${d.verification.worktree}\nHEAD ${d.verification.sha}\nChecked ${new Date(d.verification.at).toISOString()}`, "dim"));
      if (d.verification.mismatch) {
        detail.push(text("ci-mismatch", "This checkout/repository differs from the PR head. The agent must investigate the identified commits.", "warn"));
        detail.push(button("ci-acknowledge", d.acknowledged ? "Mismatch acknowledged" : "Acknowledge checkout mismatch", d.acknowledged || d.phase !== "preview"));
      }
    }
    if (d.error) detail.push(text("ci-dispatch-error", d.error, "warn"));
    if (d.phase === "verifying" || d.phase === "sending") detail.push({ kind: "progress", id: "ci-dispatch-progress", text: d.phase === "verifying" ? "Verifying session and current identities…" : "Waiting for the host to accept the prompt. Do not resend." });
    if (d.phase === "sent") detail.push(text("ci-sent", "Sent once to the selected session.", "success"));
    detail.push(button("ci-send", "Send investigation", d.phase !== "preview" || !d.session || !d.verification || (d.verification.mismatch && !d.acknowledged) || state.historical));
  }
  // Compactness comes from native width wrapping, with no fixed-width content.
  contents.push({ kind: "scroll", id: "ci-scroll", axis: "vertical", child: { kind: "vstack", id: "ci-detail", spacing: compact ? 6 : 9, children: detail } });
  return { kind: "vstack", id: "ci-root", spacing: 8, children: contents };
}
