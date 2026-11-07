import { request } from "../sdk/alas/src/index.ts";
import { stackAcquire, stackList, stackOpen, stackRelease, type NativeStack, type NativeStackAction, type ReviewIdentity, type StackInventory } from "../sdk/alas/src/stacks.ts";
import { buildStacks, reviewKey, stackScope, type FrozenScope, type StackGraph, type StackReview } from "./inbox-stacks.ts";
import { createStackOperation, nextStackStep, operationFitsStorage, restoreStackOperation, type StackOperation, type StackStep } from "./stack-operation.ts";

export interface StackProviderSnapshot { reviews: StackReview[]; complete: boolean; error?: string }
export interface StackAdapter {
  mode: "merge" | "queue";
  refresh(identities: ReviewIdentity[], done: (snapshot?: StackProviderSnapshot, error?: string) => void): void;
  retarget(member: StackReview, finalBase: string, done: (error?: string) => void): void;
  submit(member: StackReview, done: (error?: string) => void): void;
}
export type StackPageMessage = { type: "stack"; action: "open" | "close" | "cancel" | "refresh" | "prepare" | "confirm" | "stop" | "continue" | "native"; key?: string; through?: boolean; nativeAction?: NativeStackAction };
export function parseStackPageMessage(value: unknown): StackPageMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (m.type !== "stack" || typeof m.action !== "string" || !["open", "close", "cancel", "refresh", "prepare", "confirm", "stop", "continue", "native"].includes(m.action)) return undefined;
  if (m.key !== undefined && (typeof m.key !== "string" || m.key.length > 2048)) return undefined;
  if (m.through !== undefined && typeof m.through !== "boolean") return undefined;
  if (m.action === "native" && (typeof m.nativeAction !== "string" || !["open", "sync", "rebase", "land", "landThrough"].includes(m.nativeAction))) return undefined;
  return { type: "stack", action: m.action as StackPageMessage["action"], ...(typeof m.key === "string" ? { key: m.key } : {}), ...(typeof m.through === "boolean" ? { through: m.through } : {}), ...(m.action === "native" ? { nativeAction: m.nativeAction as NativeStackAction } : {}) };
}
export interface InboxStackModel {
  busy: boolean;
  badges: Record<string, { key: string; label: string; stack: string }>;
  selected?: { key: string; name: string; base: string; entries: StackReview[]; ordered: boolean; issues: string[]; native?: NativeStack; outsideFilter: string[]; mode: "merge" | "queue"; canPrepare: boolean };
  confirmation?: { members: StackReview[]; finalBase: string; mode: "merge" | "queue"; through: boolean };
  operation?: { phase: StackOperation["phase"]; done: number; total: number; error?: string; message?: string };
  error?: string;
  nativeError?: string;
}

const STORE_KEY = "inbox-stack-operation-v1";
const active = (operation?: StackOperation) => !!operation && ["running", "waiting", "stopping"].includes(operation.phase);

/** Owns one plugin's stack operation. The native host owns the project-wide reservation. */
export class InboxStackController {
  private adapter: StackAdapter;
  private changed: () => void;
  private provider: StackProviderSnapshot = { reviews: [], complete: false };
  private inventory: StackInventory = { complete: true, busy: false, stacks: [] };
  private selected?: string;
  private prepared?: { scope: FrozenScope; through: boolean };
  private operation?: StackOperation;
  private token?: string;
  private pending = false;
  private individual = false;
  private stopping = false;
  private disposed = false;
  private touched = false;
  private nativeGeneration = 0;
  private nativeLoading = false;
  private error?: string;
  private nativeError?: string;
  private waitingMessage?: string;
  private _graph: StackGraph = buildStacks([], { complete: false });

  constructor(adapter: StackAdapter, changed: () => void) { this.adapter = adapter; this.changed = changed; }
  get graph(): StackGraph { return this._graph; }
  get requiredIdentities(): ReviewIdentity[] { return this.operation && this.operation.phase !== "complete" ? this.operation.scope.allMembers.map(r => r.identity) : []; }
  get busy(): boolean { return active(this.operation) || this.pending || this.individual || this.inventory.busy || this.nativeLoading; }
  private draw(): void { if (!this.disposed) this.changed(); }
  private rebuild(): void { this._graph = buildStacks(this.provider.reviews, { complete: this.provider.complete, native: this.inventory.stacks, error: this.provider.error }); }

  activate(): void {
    request("storage/get", { key: STORE_KEY, scope: "project" }, reply => {
      if (this.disposed || this.touched) return;
      if (!reply.error && typeof reply.result === "object" && reply.result !== null) {
        const value = (reply.result as { value?: unknown }).value;
        this.operation = restoreStackOperation(value);
        if (value !== undefined && value !== null && !this.operation) this.error = "Saved stack operation is unreadable. Refresh the stack before starting again.";
        this.draw();
      }
    });
    this.refreshNative(true);
  }
  dispose(): void { this.disposed = true; this.stop(); }
  updateProvider(snapshot: StackProviderSnapshot): void {
    this.provider = snapshot; this.rebuild(); this.draw();
    if (this.operation?.phase === "waiting" && this.token && !this.pending) this.advance();
  }
  refreshNative(refresh: boolean): void {
    const generation = ++this.nativeGeneration;
    this.nativeLoading = true;
    stackList(refresh, outcome => {
      if (this.disposed || generation !== this.nativeGeneration) return;
      this.nativeLoading = false;
      const fresh = outcome.result;
      if (fresh?.complete) { this.inventory = fresh; this.nativeError = fresh.error; }
      else {
        const reason = outcome.error?.message ?? fresh?.error ?? "Native stack inventory is incomplete.";
        const retained = new Map(this.inventory.stacks.map(s => [s.id, s]));
        for (const stack of fresh?.stacks ?? []) {
          const old = retained.get(stack.id);
          const numbers = [...new Set([...(old?.entries.flatMap(e => e.number ? [e.number] : []) ?? []), ...(old?.reviewNumbers ?? []),
            ...stack.entries.flatMap(e => e.number ? [e.number] : []), ...(stack.reviewNumbers ?? [])])];
          retained.set(stack.id, { ...stack, ...(numbers.length ? { reviewNumbers: numbers } : {}) });
        }
        this.inventory = { complete: false, busy: fresh?.busy ?? this.inventory.busy,
          stacks: [...retained.values()].map(s => {
            const canNavigate = !!s.worktree && s.actions.includes("open");
            return { ...s, complete: false, actions: canNavigate ? ["open" as const] : [],
              unavailableActions: { ...(canNavigate ? {} : { open: reason }), sync: reason, rebase: reason, land: reason, landThrough: reason } };
          }), error: reason };
        this.nativeError = reason;
      }
      this.rebuild(); this.draw();
      if (active(this.operation) && !this.pending) this.cycle();
    });
  }
  handle(message: StackPageMessage): void {
    const key = message.key ?? this.selected;
    switch (message.action) {
      case "open": if (key && this.graph.byReview[key]) { this.selected = key; this.error = undefined; this.draw(); } return;
      case "close": this.selected = undefined; this.prepared = undefined; if (this.operation?.phase === "complete") this.operation = undefined; this.draw(); return;
      case "cancel": this.prepared = undefined; this.draw(); return;
      case "refresh": this.refreshNative(true); this.refreshProvider(); return;
      case "prepare": if (key) this.prepare(key, message.through === true); return;
      case "confirm": this.confirm(); return;
      case "stop": this.stop(); return;
      case "continue": this.continue(); return;
      case "native": if (key && message.nativeAction) this.openNative(key, message.nativeAction); return;
    }
  }
  prepare(key: string, through: boolean): void {
    if (this.busy || this.nativeLoading) { this.error = "Wait for the current project operation or stack refresh."; this.draw(); return; }
    const stack = this.graph.byReview[key], member = this.provider.reviews.find(r => reviewKey(r.identity) === key);
    if (!stack || !member) return;
    this.selected = key;
    if (stack.native) { this.error = "Use this stack's native gg action."; this.draw(); return; }
    const target = stackScope(stack, through ? member.identity : undefined);
    if (!target.scope) { this.error = target.error; this.draw(); return; }
    if (this.adapter.mode === "merge" && target.scope.members.some(r => !r.ready)) { this.error = "Every remaining request must be ready before starting Merge stack."; this.draw(); return; }
    this.prepared = { scope: target.scope, through }; this.error = undefined; this.draw();
  }
  confirm(): void {
    if (!this.prepared || this.busy) return;
    this.touched = true; this.stopping = false;
    this.operation = createStackOperation(this.prepared.scope, this.adapter.mode);
    this.prepared = undefined; this.waitingMessage = undefined; this.error = undefined;
    this.draw(); this.cycle();
  }
  stop(): void {
    if (!active(this.operation)) return;
    this.stopping = true; this.operation!.phase = "stopping"; this.draw();
    if (!this.pending) this.refreshAfterStop();
  }
  continue(): void {
    if (!this.operation || active(this.operation) || this.busy) return;
    this.touched = true; this.stopping = false; this.operation.phase = "running"; this.operation.error = undefined;
    // Continue is an explicit new attempt; fresh provider state decides whether a prior request still waits.
    this.operation.submitted = undefined;
    this.operation.retargeted = undefined;
    this.waitingMessage = undefined;
    this.error = undefined;
    this.draw(); this.cycle();
  }
  private refreshProvider(): void {
    if (this.pending) return;
    this.pending = true;
    this.adapter.refresh(this.operation?.scope.allMembers.map(r => r.identity) ?? [], (snapshot, error) => {
      if (snapshot) { this.provider = snapshot; this.rebuild(); }
      this.pending = false;
      if (error || !snapshot) {
        this.error = error ?? "The provider refresh failed.";
        this.provider = { ...this.provider, complete: false, error: this.error }; this.rebuild();
        if (active(this.operation)) this.stopping ? this.stopWithSnapshot(this.error) : this.finish("failed", this.error);
        this.draw(); return;
      }
      if (active(this.operation)) this.stopping ? this.stopWithSnapshot() : this.advance();
      this.draw();
    });
  }
  private stopWithSnapshot(error?: string): void {
    if (this.operation) this.operation.completed = nextStackStep(this.operation, { reviews: this.provider.reviews, graph: this.graph }).completed;
    this.finish("stopped", error);
  }
  private refreshAfterStop(error?: string): void {
    if (!this.operation || this.pending) return;
    if (this.disposed) { this.stopWithSnapshot(error); return; }
    this.pending = true;
    this.adapter.refresh(this.operation.scope.allMembers.map(r => r.identity), (snapshot, failure) => {
      this.pending = false;
      if (snapshot) { this.provider = snapshot; this.rebuild(); }
      this.stopWithSnapshot(error ?? failure ?? snapshot?.error);
    });
  }
  private cycle(): void {
    if (this.pending || !active(this.operation)) return;
    this.pending = true;
    this.adapter.refresh(this.operation!.scope.allMembers.map(r => r.identity), (snapshot, error) => {
      this.pending = false;
      if (snapshot) { this.provider = snapshot; this.rebuild(); }
      if (this.stopping) { this.stopWithSnapshot(error); return; }
      if (error || !snapshot) { this.finish("failed", error ?? "The provider refresh failed."); return; }
      this.advance();
    });
  }
  private advance(): void {
    if (!this.operation || this.pending || !active(this.operation)) return;
    if (this.stopping) { this.refreshAfterStop(); return; }
    if (this.nativeLoading) return;
    const step = nextStackStep(this.operation, { reviews: this.provider.reviews, graph: this.graph });
    if (step.kind === "blocked") { this.operation.completed = step.completed; this.finish("failed", step.error); return; }
    this.operation.completed = step.completed;
    if (step.kind === "done") { this.finish("complete"); return; }
    if (!this.token) {
      this.pending = true;
      stackAcquire(outcome => {
        this.pending = false;
        if (outcome.error) { this.stopping ? this.refreshAfterStop(outcome.error.message) : this.finish("failed", outcome.error.message); return; }
        this.token = outcome.result;
        if (this.stopping) this.refreshAfterStop();
        else this.cycle(); // Revalidate after acquiring ownership.
      });
      return;
    }
    if (step.kind === "wait") {
      this.operation.phase = "waiting";
      this.waitingMessage = step.waitingFor === "base" ? `Waiting for target branch confirmation on #${step.member.identity.number}.` : `Waiting for #${step.member.identity.number} to merge.`;
      this.save(() => { this.draw(); });
      return;
    }
    this.operation.phase = "running";
    this.waitingMessage = undefined;
    this.save(() => this.write(step));
  }
  private write(step: Extract<StackStep, { kind: "submit" | "retarget" | "wait" }>): void {
    if (this.stopping) { this.refreshAfterStop(); return; }
    if (!this.operation || step.kind === "wait") return;
    if (this.nativeLoading) return;
    const current = nextStackStep(this.operation, { reviews: this.provider.reviews, graph: this.graph });
    if (current.kind !== step.kind || !("member" in current) || reviewKey(current.member.identity) !== reviewKey(step.member.identity)) { this.advance(); return; }
    this.pending = true;
    const done = (error?: string) => {
      this.pending = false;
      if (!this.operation) return;
      if (step.kind === "submit" && !error) this.operation.submitted = reviewKey(step.member.identity);
      if (step.kind === "retarget" && !error) this.operation.retargeted = [...new Set([...(this.operation.retargeted ?? []), reviewKey(step.member.identity)])];
      if (this.stopping) { this.refreshAfterStop(error); return; }
      if (error) { this.finish("failed", error); return; }
      this.save(() => this.cycle());
    };
    if (step.kind === "retarget") this.adapter.retarget(step.member, this.operation.scope.finalBase, done);
    else this.adapter.submit(step.member, done);
  }
  private save(done: () => void): void {
    if (this.disposed) { done(); return; }
    if (!this.operation) { done(); return; }
    if (!operationFitsStorage(this.operation)) { this.storageFailure("The stack operation is too large to save safely."); return; }
    this.pending = true;
    request("storage/set", { key: STORE_KEY, scope: "project", value: this.operation.phase === "complete" ? null : this.operation }, reply => {
      this.pending = false;
      if (reply.error) { this.storageFailure(reply.error.message); return; }
      if (this.stopping && this.operation?.phase !== "stopped") this.refreshAfterStop();
      else done();
    });
  }
  private storageFailure(error: string): void {
    if (this.operation) { this.operation.phase = "failed"; this.operation.error ??= error; }
    this.error = error; this.release(() => this.draw());
  }
  private finish(phase: "stopped" | "failed" | "complete", error?: string): void {
    if (!this.operation) return;
    this.operation.phase = phase;
    this.waitingMessage = undefined;
    if (error) this.operation.error ??= error;
    this.save(() => this.release(() => this.draw()));
  }
  private release(done: () => void): void {
    const token = this.token;
    if (!token) { done(); return; }
    this.token = undefined; this.pending = true;
    stackRelease(token, outcome => {
      this.pending = false;
      if (outcome.error) this.error = outcome.error.message;
      done();
    });
  }
  /** Existing individual/bulk provider actions participate in the same host reservation. */
  runMutation(execute: (done: (error?: string) => void) => void, done: (error?: string) => void): void {
    if (this.busy || this.disposed) { done("A project mutation is already running."); return; }
    this.touched = true; this.individual = true; this.draw();
    stackAcquire(outcome => {
      if (outcome.error) { this.individual = false; this.draw(); done(outcome.error.message); return; }
      const release = (error?: string) => stackRelease(outcome.result, reply => { this.individual = false; this.draw(); done(error ?? reply.error?.message); });
      if (this.disposed) { release("The plugin stopped before the action started."); return; }
      try { execute(release); } catch (error) { release(String(error)); }
    });
  }
  private openNative(key: string, action: NativeStackAction): void {
    const component = this.graph.byReview[key], native = component?.native;
    if (!native || !native.actions.includes(action)) { this.error = native?.unavailableActions?.[action] ?? "This native action is unavailable."; this.draw(); return; }
    if (action !== "open" && (this.busy || (action === "land" || action === "landThrough") && !component.complete)) { this.error = component.issues[0] ?? "A project mutation is already running."; this.draw(); return; }
    const member = component.members.find(r => reviewKey(r.identity) === key);
    const entry = native.entries.find(e => e.number === member?.identity.number);
    if (action === "landThrough" && !entry) return;
    stackOpen({ stack: native.id, fingerprint: native.fingerprint, action, ...(action === "landThrough" ? { entry: entry!.id } : {}) }, outcome => {
      if (this.disposed) return;
      if (outcome.error) this.error = outcome.error.message;
      this.refreshNative(false); this.draw();
    });
  }
  model(viewer = "", mineOnly = false): InboxStackModel {
    const badges: InboxStackModel["badges"] = {};
    for (const [key, component] of Object.entries(this.graph.byReview)) {
      const member = component.members.find(r => reviewKey(r.identity) === key)!;
      const nativePosition = component.native?.entries.find(e => e.number === member.identity.number)?.position;
      const position = nativePosition ?? (component.order ? component.order.indexOf(member) + 1 : undefined);
      const total = component.native?.entries.length || component.members.length;
      badges[key] = { key, stack: component.id, label: `${component.native ? "gg · " : ""}Stack${position ? ` ${position}/${total}` : ""}` };
    }
    const component = this.selected ? this.graph.byReview[this.selected] : undefined;
    return { busy: this.busy, badges,
      ...(component ? { selected: { key: this.selected!, name: component.name, base: component.finalBase, entries: component.order ?? component.members, ordered: !!component.order || !!component.native?.entries.length && [...component.native.entries].sort((a, b) => a.position - b.position).every((e, i) => e.position === i + 1), issues: component.issues, native: component.native,
        outsideFilter: mineOnly && viewer ? component.members.filter(r => r.author.toLowerCase() !== viewer.toLowerCase()).map(r => reviewKey(r.identity)) : [],
        mode: this.adapter.mode, canPrepare: component.complete && !!component.order && !component.native && !this.busy && !this.nativeLoading
          && (this.adapter.mode !== "merge" || component.members.every(r => r.state === "merged" || r.ready)) } } : {}),
      ...(this.prepared ? { confirmation: { members: this.prepared.scope.members, finalBase: this.prepared.scope.finalBase, mode: this.adapter.mode, through: this.prepared.through } } : {}),
      ...(this.operation ? { operation: { phase: this.operation.phase, done: this.operation.completed.length, total: this.operation.scope.members.length, error: this.operation.error, message: this.waitingMessage } } : {}),
      error: this.error, nativeError: this.nativeError };
  }
}
