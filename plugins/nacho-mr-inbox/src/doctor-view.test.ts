import { test } from "node:test";
import assert from "node:assert/strict";
import { doctorModel } from "./doctor-view.ts";

test("without evidence the doctor says it is fetching the MR", () => {
  const m = doctorModel({ target: { repo: "acme/shop", pull: { number: 12, title: "MR", url: "https://gitlab.example.com/acme/shop/-/merge_requests/12", branch: "f" } }, loading: true, historyLoading: false, cached: false, historical: false, snapshot: { worktrees: [] } });
  assert.equal(m.unavailable, "Fetching MR identity…");
  assert.equal(m.number, 12);
});
