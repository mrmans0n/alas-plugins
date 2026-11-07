import { fullSHA, reviewKey, type FrozenScope, type StackGraph, type StackReview } from "./inbox-stacks.ts";

export interface OperationSnapshot { reviews: StackReview[]; graph: StackGraph }
export interface StackOperation {
  version: 1;
  mode: "merge" | "queue";
  scope: FrozenScope;
  phase: "running" | "waiting" | "stopping" | "stopped" | "failed" | "interrupted" | "complete";
  completed: string[];
  submitted?: string;
  retargeted?: string[];
  error?: string;
}
export type StackStep =
  | { kind: "submit" | "retarget" | "wait"; member: StackReview; completed: string[]; waitingFor?: "merge" | "base" }
  | { kind: "done"; completed: string[] }
  | { kind: "blocked"; error: string; completed: string[] };

export function createStackOperation(scope: FrozenScope, mode: "merge" | "queue"): StackOperation {
  return { version: 1, mode, scope: JSON.parse(JSON.stringify(scope)) as FrozenScope, phase: "running", completed: [] };
}
export function nextStackStep(operation: StackOperation, snapshot: OperationSnapshot): StackStep {
  let knownCompleted = [...operation.completed];
  const blocked = (error: string): StackStep => ({ kind: "blocked", error, completed: knownCompleted });
  const current = new Map(snapshot.reviews.map(r => [reviewKey(r.identity), r]));
  if (current.size !== snapshot.reviews.length) return blocked("The provider returned duplicate request identities.");
  knownCompleted = [...new Set([...knownCompleted, ...operation.scope.members.filter(expected => {
    const actual = current.get(reviewKey(expected.identity));
    return actual?.state === "merged" && actual.sha === expected.sha && actual.base === operation.scope.finalBase;
  }).map(r => reviewKey(r.identity))])];
  if (!snapshot.graph.complete) return blocked(snapshot.graph.error ?? "The request list is incomplete.");
  const allowed = new Set(operation.scope.allMembers.map(r => reviewKey(r.identity)));
  for (let index = 0; index < operation.scope.allMembers.length; index++) {
    const expected = operation.scope.allMembers[index], key = reviewKey(expected.identity), actual = current.get(key);
    if (!actual || actual.state === "unknown") return blocked(`The state of #${expected.identity.number} is unavailable.`);
    if (actual.state === "closed") return blocked(`#${expected.identity.number} was closed without merging.`);
    if (expected.sha && actual.sha !== expected.sha) return blocked(`The head of #${expected.identity.number} changed. Review a new scope.`);
    if (actual.branch !== expected.branch || actual.sourceRepo?.toLowerCase() !== expected.sourceRepo?.toLowerCase()) return blocked("The stack's branch identity changed.");
    const predecessorsMerged = operation.scope.allMembers.slice(0, index).every(r => current.get(reviewKey(r.identity))?.state === "merged");
    if (actual.base !== expected.base && !(predecessorsMerged && actual.base === operation.scope.finalBase)) return blocked("The stack's base branch changed.");
    if (expected.state !== "merged" && actual.state === "merged" && actual.base !== operation.scope.finalBase) return blocked(`Request #${expected.identity.number} merged into another branch.`);
    if (actual.blockersComplete === false) return blocked("Dependency information is incomplete.");
    const before = new Set((expected.blockers ?? []).map(reviewKey));
    const after = new Set((actual.blockers ?? []).map(reviewKey));
    if ([...after].some(id => !before.has(id)) || [...before].some(id => !after.has(id) && current.get(id)?.state !== "merged")) return blocked("The stack's dependencies changed.");
    const component = snapshot.graph.byReview[key];
    if (component?.native) return blocked("A native stack tool now manages these requests. Review its native action.");
    if (component?.members.some(r => !allowed.has(reviewKey(r.identity)))) return blocked("The stack gained a member. Review a new scope.");
  }
  const members = operation.scope.members.map(r => current.get(reviewKey(r.identity))!);
  if (operation.mode === "merge" && operation.completed.length === 0 && !operation.submitted && members.some(r => r.state !== "merged" && !r.ready)) return blocked("Every remaining request must be ready before starting Merge stack.");
  const completed = members.filter(r => r.state === "merged").map(r => reviewKey(r.identity));
  if (operation.completed.some(key => !completed.includes(key))) return blocked("The provider no longer confirms an earlier merge.");
  const member = members.find(r => r.state !== "merged");
  if (!member) return { kind: "done", completed };
  const key = reviewKey(member.identity);
  if (member.queued || operation.submitted === key) return { kind: "wait", member, completed, waitingFor: "merge" };
  if (member.base !== operation.scope.finalBase) return operation.retargeted?.includes(key)
    ? { kind: "wait", member, completed, waitingFor: "base" }
    : { kind: "retarget", member, completed };
  if (!member.ready && !(operation.mode === "queue" && member.canQueue)) return blocked(`Request #${member.identity.number} is not ready.`);
  return { kind: "submit", member, completed };
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max;
function validReview(v: unknown): v is StackReview {
  if (!object(v) || !object(v.identity)) return false;
  const identity = v.identity;
  return text(identity.host, 256) && !!identity.host && text(identity.repo, 512) && !!identity.repo
    && Number.isSafeInteger(identity.number) && (identity.number as number) > 0
    && text(v.branch, 1024) && text(v.base, 1024) && text(v.title) && text(v.url) && text(v.author, 256)
    && typeof v.state === "string" && ["open", "merged", "closed", "unknown"].includes(v.state) && typeof v.ready === "boolean"
    && (v.sourceRepo === undefined || text(v.sourceRepo, 512)) && (v.sha === undefined || fullSHA(v.sha))
    && (v.canQueue === undefined || typeof v.canQueue === "boolean") && (v.queued === undefined || typeof v.queued === "boolean")
    && (v.blockersComplete === undefined || typeof v.blockersComplete === "boolean")
    && (v.blockers === undefined || Array.isArray(v.blockers) && v.blockers.length <= 500 && v.blockers.every(b => object(b) && text(b.host, 256) && text(b.repo, 512) && Number.isSafeInteger(b.number) && (b.number as number) > 0));
}
/** Leave room in the project's 1 MiB store for CI Doctor and view preferences. */
export function operationFitsStorage(value: unknown): boolean {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { return false; }
  if (encoded === undefined || encoded.length > 768 * 1024) return false;
  let bytes = 0;
  for (const character of encoded) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 768 * 1024) return false;
  }
  return true;
}
/** Stored work never resumes merely because a plugin restarted. Provider state must be refreshed first. */
export function restoreStackOperation(value: unknown): StackOperation | undefined {
  if (!operationFitsStorage(value) || !object(value) || value.version !== 1 || typeof value.mode !== "string" || !["merge", "queue"].includes(value.mode) || !object(value.scope)) return undefined;
  const scope = value.scope;
  if (!text(scope.stack, 1024) || !scope.stack || !text(scope.finalBase, 1024) || !scope.finalBase || !text(scope.fingerprint, 512 * 1024)
    || !Array.isArray(scope.members) || !scope.members.length || scope.members.length > 500 || !scope.members.every(validReview)
    || !Array.isArray(scope.allMembers) || !scope.allMembers.length || scope.allMembers.length > 500 || !scope.allMembers.every(validReview)
    || !Array.isArray(value.completed) || !value.completed.every(key => typeof key === "string")
    || value.error !== undefined && !text(value.error, 8000)) return undefined;
  const targets = scope.members.map(r => reviewKey(r.identity));
  const all = scope.allMembers.map(r => reviewKey(r.identity));
  const pending = scope.allMembers.filter(r => r.state !== "merged").map(r => reviewKey(r.identity));
  if (new Set(all).size !== all.length || new Set(targets).size !== targets.length
    || targets.some((key, index) => key !== pending[index]) || new Set(value.completed).size !== value.completed.length || value.completed.some(key => !targets.includes(key as string))
    || value.retargeted !== undefined && (!Array.isArray(value.retargeted) || value.retargeted.some(key => typeof key !== "string" || !targets.includes(key)))
    || value.submitted !== undefined && (typeof value.submitted !== "string" || !targets.includes(value.submitted))) return undefined;
  return { ...(value as unknown as StackOperation), phase: "interrupted" };
}
