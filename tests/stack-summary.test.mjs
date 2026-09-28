import assert from "node:assert/strict";
import { VIEWER, loadBackground, plain, pullNode, sha, stackData } from "./harness.mjs";

const { api } = loadBackground();

const approvedBy = (login, oid) => ({
  latestOpinionatedReviews: { nodes: [{ author: { login }, state: "APPROVED", commit: { oid } }] },
});

// Positions arrive out of order; the summary must list the base-most entry first.
const merged = pullNode(10, { state: "MERGED", headRefName: "a", mergeStateStatus: "UNKNOWN" });
const base = pullNode(11, { headRefName: "b", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", ...approvedBy(VIEWER, sha("a")) });
const middle = pullNode(12, { headRefName: "c", baseRefName: "b", ...approvedBy(VIEWER, sha("0")) });
const mine = pullNode(13, { headRefName: "d", baseRefName: "c", author: { login: VIEWER } });
const data = stackData(middle, [merged, base, middle, mine]);
data.repository.pullRequest.stack.entries.nodes.reverse();

const summary = plain(api.summarizeStack(data, 12));
assert.equal(summary.viewer, VIEWER);
assert.equal(summary.mergeMethod, "SQUASH");
assert.equal(summary.isStack, true);
assert.deepEqual(summary.stack.map((pull) => pull.number), [10, 11, 12, 13]);

const byNumber = Object.fromEntries(summary.stack.map((pull) => [pull.number, pull]));
assert.equal(byNumber[10].mergeState, "merged");
assert.equal(byNumber[10].mergeTarget, false, "merged entries are never merge targets");
assert.equal(byNumber[11].mergeTarget, true, "the lowest open entry targets the stack base");
assert.equal(byNumber[12].mergeTarget, false, "upper entries wait for the lower ones");
assert.equal(byNumber[13].mergeTarget, false);

assert.equal(byNumber[11].approval, "approved");
assert.equal(byNumber[11].viewerCanApprove, false, "an approval at the current head is not offered again");
assert.equal(byNumber[12].approval, "stale");
assert.equal(byNumber[12].viewerCanApprove, true, "an approval on an older commit can be renewed");
assert.equal(byNumber[13].approval, "author");
assert.equal(byNumber[13].viewerCanApprove, false, "GitHub rejects self-approval");

const single = plain(api.summarizeStack(stackData(pullNode(20, { baseRefName: "main", mergeStateStatus: "CLEAN" })), 20));
assert.equal(single.isStack, false);
assert.equal(single.stack.length, 1);
assert.equal(single.stack[0].mergeTarget, true, "an unstacked open PR can be merged");
assert.equal(single.stack[0].approval, "pending");

const draft = plain(api.summarizeStack(stackData(pullNode(21, { isDraft: true })), 21)).stack[0];
assert.equal(draft.viewerCanApprove, false);
assert.equal(draft.mergeState, "draft");

const status = (overrides) => plain(api.mergeStatus(pullNode(1, overrides))).state;
const checks = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
assert.equal(status({ mergeStateStatus: "CLEAN" }), "mergeable");
assert.equal(status({ mergeStateStatus: "UNSTABLE" }), "mergeable");
assert.equal(status({ mergeStateStatus: "HAS_HOOKS" }), "mergeable");
assert.equal(status({ mergeStateStatus: "DIRTY" }), "conflicts");
assert.equal(status({ mergeStateStatus: "BEHIND" }), "behind");
assert.equal(status({ mergeStateStatus: "UNKNOWN" }), "checking");
assert.equal(status({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), "approval required");
assert.equal(status({ mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }), "changes requested");
assert.equal(status({ mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED", ...checks("PENDING") }), "checks pending");
assert.equal(status({ mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED", ...checks("FAILURE") }), "checks failing");
assert.equal(status({ mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED" }), "blocked");

assert.throws(
  () => api.summarizeStack({ viewer: { login: VIEWER }, repository: { pullRequest: null } }, 5),
  (error) => error.code === "NOT_FOUND"
);

console.log("stack summary: ok");
