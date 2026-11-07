import type { NativeStack, ReviewIdentity } from "../sdk/alas/src/stacks.ts";

export interface StackReview {
  identity: ReviewIdentity;
  sourceRepo?: string;
  branch: string;
  base: string;
  sha?: string;
  title: string;
  url: string;
  author: string;
  state: "open" | "merged" | "closed" | "unknown";
  ready: boolean;
  /** GitLab can accept a merge-train/auto-merge request while its pipeline is still running. */
  canQueue?: boolean;
  status?: "ready" | "waiting" | "failing" | "drafts" | "blocked";
  queued?: boolean;
  blockers?: ReviewIdentity[];
  blockersComplete?: boolean;
}
export interface StackComponent {
  id: string;
  name: string;
  members: StackReview[];
  order?: StackReview[];
  native?: NativeStack;
  issues: string[];
  complete: boolean;
  finalBase: string;
  fingerprint: string;
}
export interface StackGraph {
  components: StackComponent[];
  byReview: Record<string, StackComponent>;
  blocked: Record<string, string>;
  complete: boolean;
  error?: string;
}
export interface FrozenScope {
  stack: string;
  fingerprint: string;
  finalBase: string;
  members: StackReview[];
  allMembers: StackReview[];
}
export function reviewKey(identity: ReviewIdentity): string {
  return `${identity.host.toLowerCase()}|${identity.repo.toLowerCase()}#${identity.number}`;
}
export const fullSHA = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha);
const branchKey = (host: string, repo: string, branch: string): string => `${host.toLowerCase()}|${repo.toLowerCase()}|${branch}`;
const sameRepo = (a: ReviewIdentity, b: ReviewIdentity): boolean => a.host.toLowerCase() === b.host.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/** Membership is established before any inbox filter is applied. Unknown blockers stay in the graph. */
export function buildStacks(reviews: StackReview[], options: { complete: boolean; native?: NativeStack[]; error?: string }): StackGraph {
  const result: StackGraph = { components: [], byReview: {}, blocked: {}, complete: options.complete, error: options.error };
  const nodes = new Map<string, StackReview>();
  const leaders = new Map<string, string>();
  const parents = new Map<string, Set<string>>();
  const issues = new Map<string, string[]>();
  const nativeFor = new Map<string, NativeStack[]>();
  const issue = (key: string, message: string) => issues.set(key, [...(issues.get(key) ?? []), message]);
  const insert = (review: StackReview) => {
    const key = reviewKey(review.identity);
    if (nodes.has(key)) { issue(key, "Duplicate review identity."); return; }
    nodes.set(key, review); leaders.set(key, key); parents.set(key, new Set());
  };
  reviews.forEach(insert);
  const find = (key: string): string => {
    let current = key;
    while (leaders.get(current) !== current) current = leaders.get(current)!;
    return current;
  };
  const join = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) leaders.set(y, x); };
  const ensure = (identity: ReviewIdentity): string => {
    const key = reviewKey(identity);
    if (!nodes.has(key)) insert({ identity, branch: "", base: "", title: `Unavailable dependency ${identity.repo}#${identity.number}`, url: "", author: "", state: "unknown", ready: false });
    return key;
  };
  const sources = new Map<string, string[]>();
  for (const [key, review] of nodes) {
    if (review.sourceRepo && review.branch) {
      const branch = branchKey(review.identity.host, review.sourceRepo, review.branch);
      sources.set(branch, [...(sources.get(branch) ?? []), key]);
    }
    if (!options.complete) result.blocked[key] = options.error ?? "The request list is incomplete.";
    if (review.blockersComplete === false) result.blocked[key] = "Dependency information is incomplete.";
    if (review.state === "open" && (!review.sourceRepo || !review.base || !fullSHA(review.sha))) result.blocked[key] = "Repository, branch, or head identity is incomplete.";
  }
  for (const review of reviews) {
    const key = reviewKey(review.identity);
    const matching = (sources.get(branchKey(review.identity.host, review.identity.repo, review.base)) ?? []).filter(p => p !== key);
    if (matching.length > 1) issue(key, "Several requests have the same source branch.");
    for (const parent of matching) { parents.get(key)!.add(parent); join(key, parent); }
    for (const identity of review.blockers ?? []) {
      const parent = ensure(identity);
      parents.get(key)!.add(parent); join(key, parent);
      if (!sameRepo(identity, review.identity)) issue(key, "This dependency belongs to another project.");
    }
    if (review.blockersComplete === false && (review.blockers?.length || parents.get(key)!.size)) issue(key, "Dependency information is incomplete.");
  }
  for (const native of options.native ?? []) {
    const numbers = [...new Set([...native.entries.flatMap(e => e.number ? [e.number] : []), ...(native.reviewNumbers ?? [])])];
    const keys = numbers.map(number => ensure({ host: native.host, repo: native.repo, number }));
    for (const key of keys) {
      nativeFor.set(key, [...(nativeFor.get(key) ?? []), native]);
      join(keys[0], key);
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of nodes.keys()) { const root = find(key); groups.set(root, [...(groups.get(root) ?? []), key]); }
  for (const keys of groups.values()) {
    keys.sort();
    const members = keys.map(key => nodes.get(key)!);
    const natives = [...new Map(keys.flatMap(key => nativeFor.get(key) ?? []).map(n => [n.id, n])).values()];
    const problems = keys.flatMap(key => issues.get(key) ?? []);
    if (keys.length === 1 && !parents.get(keys[0])!.size && !natives.length && !problems.length) continue;
    const native = natives[0];
    if (natives.length > 1) problems.push("Stack metadata disagrees about membership.");
    let order: StackReview[] | undefined;
    if (native) {
      const entries = [...native.entries].sort((a, b) => a.position - b.position);
      const positions = entries.map(e => e.position);
      if (!native.complete) problems.push("Native stack membership is incomplete.");
      if (entries.length !== keys.length || new Set(positions).size !== entries.length || positions.some((p, i) => p !== i + 1)) problems.push("Native stack order or mapping is incomplete.");
      const ordered: StackReview[] = [];
      for (const entry of entries) {
        const review = entry.number ? nodes.get(reviewKey({ host: native.host, repo: native.repo, number: entry.number })) : undefined;
        if (!review) { problems.push("An unpublished stack entry has no request mapping."); continue; }
        ordered.push(review);
        if (!entry.sha || !review.sha || !review.sha.toLowerCase().startsWith(entry.sha.toLowerCase()) || entry.sha.length < 7) problems.push(`Head identity differs for #${entry.number}.`);
      }
      if (ordered.length === keys.length && new Set(ordered.map(r => reviewKey(r.identity))).size === keys.length) {
        order = ordered;
        const indexes = new Map(ordered.map((r, i) => [reviewKey(r.identity), i]));
        for (const key of keys) for (const parent of parents.get(key)!) if ((indexes.get(parent) ?? Infinity) >= indexes.get(key)!) problems.push("Dependency order conflicts with native stack metadata.");
        for (let index = 0; index < ordered.length; index++) {
          const review = ordered[index];
          if (review.state === "open" && review.base !== native.base && !ordered.slice(0, index).some(parent => parent.branch === review.base && parent.sourceRepo?.toLowerCase() === native.repo.toLowerCase())) problems.push(`Target branch differs from native stack metadata for #${review.identity.number}.`);
        }
      }
    } else {
      const children = new Map(keys.map(key => [key, [] as string[]]));
      for (const key of keys) for (const parent of parents.get(key)!) children.get(parent)!.push(key);
      const roots = keys.filter(key => parents.get(key)!.size === 0);
      if (roots.length === 1 && keys.every(key => parents.get(key)!.size <= 1 && children.get(key)!.length <= 1)) {
        const visited = new Set<string>(); const ordered: StackReview[] = [];
        let current: string | undefined = roots[0];
        while (current && !visited.has(current)) { visited.add(current); ordered.push(nodes.get(current)!); current = children.get(current)![0]; }
        if (visited.size === keys.length) order = ordered;
      }
      if (!order) problems.push("Dependencies do not form one ordered chain.");
    }
    if (members.some(r => r.state === "unknown")) problems.push("A dependency is missing or inaccessible.");
    if (members.some(r => r.state === "closed")) problems.push("A dependency was closed without merging.");
    for (const key of keys) if (result.blocked[key]) problems.push(result.blocked[key]);
    const finalBase = native?.base ?? order?.[0]?.base ?? "";
    if (!finalBase) problems.push("The final base branch is unknown.");
    const component: StackComponent = {
      id: native?.id ?? keys[0], name: native?.name ?? `Stack · ${members.length} requests`, members, order, native,
      issues: [...new Set(problems)], complete: options.complete && !problems.length,
      finalBase, fingerprint: JSON.stringify({ native: native?.fingerprint, members: (order ?? members).map(r => [reviewKey(r.identity), r.sha, r.sourceRepo, r.branch, r.base, (r.blockers ?? []).map(reviewKey).sort()]) }),
    };
    result.components.push(component);
    for (const key of keys) {
      result.byReview[key] = component;
      // Independent bulk writes must exclude every known or unresolved stack member.
      result.blocked[key] = component.issues[0] ?? "This request belongs to a stack. Use its stack action.";
    }
  }
  result.components.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
export function stackScope(stack: StackComponent, through?: ReviewIdentity): { scope?: FrozenScope; error?: string } {
  if (!stack.complete || !stack.order) return { error: stack.issues[0] ?? "Stack membership is incomplete." };
  const index = through ? stack.order.findIndex(r => reviewKey(r.identity) === reviewKey(through)) : stack.order.length - 1;
  if (index < 0) return { error: "The selected request is no longer in this stack." };
  const members = stack.order.slice(0, index + 1).filter(r => r.state !== "merged");
  if (!members.length) return { error: "Every request in this scope is already merged." };
  if (members.some(r => r.state !== "open" || !fullSHA(r.sha))) return { error: "The request state or head identity is unknown." };
  return { scope: { stack: stack.id, fingerprint: stack.fingerprint, finalBase: stack.finalBase,
    members: members.map(r => ({ ...r, identity: { ...r.identity }, blockers: r.blockers?.map(b => ({ ...b })) })),
    allMembers: stack.order.map(r => ({ ...r, identity: { ...r.identity }, blockers: r.blockers?.map(b => ({ ...b })) })),
  } };
}

/** Individual merge buttons retain their scope. A prefix merge must have a different label. */
export function individualBlocker(graph: StackGraph, identity: ReviewIdentity): string | undefined {
  const component = graph.byReview[reviewKey(identity)];
  if (!component) return undefined;
  const member = component.members.find(r => reviewKey(r.identity) === reviewKey(identity));
  if (!member) return "Request identity is unavailable.";
  if (component.native && !component.complete) return component.issues[0] ?? "Native stack order is unavailable.";
  const explicit = new Set((member.blockers ?? []).map(reviewKey));
  const blockers = component.members.filter(r => reviewKey(r.identity) !== reviewKey(identity) && r.state !== "merged" &&
    (explicit.has(reviewKey(r.identity)) || r.identity.host.toLowerCase() === identity.host.toLowerCase()
      && r.sourceRepo?.toLowerCase() === identity.repo.toLowerCase() && r.branch === member.base));
  if (component.native && component.order) {
    const index = component.order.indexOf(member);
    const predecessor = component.order.slice(0, index).find(r => r.state !== "merged");
    if (predecessor && !blockers.includes(predecessor)) blockers.push(predecessor);
  }
  if (blockers.length) return `Depends on #${blockers[0].identity.number}. Use the stack action to include its predecessors.`;
  if (member.blockersComplete === false) return "Dependency information is incomplete.";
  return undefined;
}
