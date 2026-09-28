import assert from "node:assert/strict";
import { VIEWER, loadBackground, plain, pullNode, rejectsWith, sha, stackData } from "./harness.mjs";

const OWNER = "Delta-Exchange-Org";
const REPO = "support-chatbot";
const HEAD = sha("a");
const target = (number, expectedSha = HEAD) => ({ owner: OWNER, repo: REPO, number, expectedSha });

const isStackQuery = (request) => request.body?.query?.includes("query StackActions");
const isApproval = (request) => request.body?.query?.includes("mutation ApprovePull");
const approvalResponse = (oid = HEAD) => [
  200,
  { data: { addPullRequestReview: { pullRequestReview: { url: "https://github.com/review/1", state: "APPROVED", commit: { oid } } } } },
];

// A missing token fails before any request is made.
{
  const { api, requests } = loadBackground({ token: null });
  await rejectsWith(api.storedToken(), "TOKEN_REQUIRED");
  assert.equal(requests.length, 0);
}

// Approve re-reads the PR, then submits an APPROVE review pinned to the expected head.
{
  const { api, requests } = loadBackground({
    handler: (request) => (isStackQuery(request) ? [200, { data: stackData(pullNode(7)) }] : approvalResponse()),
  });
  const result = plain(await api.approvePull(target(7), "ghp_test"));
  assert.deepEqual(result, {
    action: "approved",
    number: 7,
    headSha: HEAD,
    reviewUrl: "https://github.com/review/1",
    viewer: VIEWER,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.github.com/graphql");
  assert.equal(requests[0].headers.Authorization, "Bearer ghp_test");
  assert.deepEqual(plain(requests[0].body.variables), { owner: OWNER, repo: REPO, number: 7 });
  assert.ok(isApproval(requests[1]));
  assert.deepEqual(plain(requests[1].body.variables), { pullRequestId: "PR_7", commitOID: HEAD });
}

// A moved head, a self-authored PR, or an existing approval never reaches the mutation.
{
  const cases = [
    [pullNode(7, { headRefOid: sha("b") }), "HEAD_CHANGED"],
    [pullNode(7, { author: { login: VIEWER } }), "APPROVAL_UNAVAILABLE"],
    [pullNode(7, { latestOpinionatedReviews: { nodes: [{ author: { login: VIEWER }, state: "APPROVED", commit: { oid: HEAD } }] } }), "APPROVAL_UNAVAILABLE"],
  ];
  for (const [node, code] of cases) {
    const { api, requests } = loadBackground({ handler: () => [200, { data: stackData(node) }] });
    await rejectsWith(api.approvePull(target(7), "ghp_test"), code);
    assert.equal(requests.filter(isApproval).length, 0, `${code} must not submit a review`);
  }
}

// Approve all reports each PR separately and keeps going after a failure.
{
  const heads = { 7: HEAD, 8: sha("c") };
  const { api } = loadBackground({
    handler: (request) =>
      isStackQuery(request)
        ? [200, { data: stackData(pullNode(request.body.variables.number, { headRefOid: heads[request.body.variables.number] })) }]
        : approvalResponse(),
  });
  const { results } = plain(
    await api.approveAll({ owner: OWNER, repo: REPO, pulls: [{ number: 7, expectedSha: HEAD }, { number: 8, expectedSha: HEAD }] }, "ghp_test")
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, "HEAD_CHANGED");
}

// Merge refuses upper stack entries and blocked PRs without calling the merge endpoint.
{
  const base = pullNode(11, { headRefName: "b", mergeStateStatus: "CLEAN" });
  const upper = pullNode(12, { headRefName: "c", baseRefName: "b", mergeStateStatus: "CLEAN" });
  const { api, requests } = loadBackground({ handler: () => [200, { data: stackData(upper, [base, upper]) }] });
  await rejectsWith(api.mergePull(target(12), "ghp_test"), "STACK_ORDER");

  const blocked = loadBackground({ handler: () => [200, { data: stackData(pullNode(7)) }] });
  await rejectsWith(blocked.api.mergePull(target(7), "ghp_test"), "MERGE_BLOCKED");
  assert.equal([...requests, ...blocked.requests].filter((request) => request.method === "PUT").length, 0);
}

// Merge sends the expected head and the viewer's default method, then polls until merged.
{
  const mergePath = `https://api.github.com/repos/${OWNER}/${REPO}/pulls/7/merge-async`;
  const { api, requests } = loadBackground({
    handler: (request) => {
      if (isStackQuery(request)) return [200, { data: stackData(pullNode(7, { mergeStateStatus: "CLEAN" })) }];
      if (request.method === "PUT") {
        return [202, { status: "pending", details: { message: "Merge request enqueued.", uuid: "u-1", merge_method: "squash", merge_action: "default", expected_head_sha: HEAD } }];
      }
      return [200, { status: "merged", details: { message: "Pull request was merged.", sha: sha("f") } }];
    },
  });
  const result = plain(await api.mergePull(target(7), "ghp_test"));
  assert.deepEqual(result, { action: "merged", number: 7, headSha: HEAD, mergeSha: sha("f") });
  const put = requests.find((request) => request.method === "PUT");
  assert.equal(put.url, mergePath);
  assert.deepEqual(plain(put.body), { sha: HEAD, merge_action: "default", merge_method: "squash" });
  assert.equal(requests.at(-1).method, "GET");
  assert.equal(requests.at(-1).url, `${mergePath}/u-1`);
}

// With a merge queue, GitHub picks the method and the PR is reported as enqueued.
{
  const { api, requests } = loadBackground({
    handler: (request) =>
      isStackQuery(request)
        ? [200, { data: stackData(pullNode(7, { mergeStateStatus: "CLEAN", isMergeQueueEnabled: true })) }]
        : [200, { status: "enqueued", details: { message: "Pull request is in the merge queue." } }],
  });
  assert.equal(plain(await api.mergePull(target(7), "ghp_test")).action, "enqueued");
  assert.deepEqual(plain(requests.find((request) => request.method === "PUT").body), { sha: HEAD, merge_action: "default" });
}

// A failed async merge surfaces GitHub's reason.
{
  const { api } = loadBackground({
    handler: (request) =>
      isStackQuery(request)
        ? [200, { data: stackData(pullNode(7, { mergeStateStatus: "CLEAN" })) }]
        : [400, { status: "failed", details: { message: "Pull request is closed." } }],
  });
  const error = await rejectsWith(api.mergePull(target(7), "ghp_test"), "MERGE_FAILED");
  assert.match(error.message, /Pull request is closed\./);
}

// Mergeability that GitHub has not computed yet is re-read before it is reported.
{
  let reads = 0;
  const { api } = loadBackground({
    handler: () => {
      reads += 1;
      return [200, { data: stackData(pullNode(7, { mergeStateStatus: reads === 1 ? "UNKNOWN" : "CLEAN" })) }];
    },
  });
  assert.equal(plain(await api.loadStack(target(7), "ghp_test")).stack[0].mergeState, "mergeable");
  assert.equal(reads, 2);
}

// Token and GraphQL errors carry GitHub's explanation.
{
  const { api } = loadBackground({ handler: () => [401, { message: "Bad credentials" }] });
  await rejectsWith(api.loadStack(target(7), "ghp_bad"), "TOKEN_INVALID");

  const sso = loadBackground({
    handler: () => [200, { data: null, errors: [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }] }],
  });
  const error = await rejectsWith(sso.api.loadStack(target(7), "ghp_test"), "FORBIDDEN");
  assert.match(error.message, /SAML enforcement/);
}

// Saving a token verifies it with GitHub before storing it.
{
  const { api, storage } = loadBackground({ token: null, handler: () => [200, { data: { viewer: { login: VIEWER } } }] });
  assert.deepEqual(plain(await api.saveToken("  ghp_new  ")), { login: VIEWER });
  assert.equal(storage.token, "ghp_new");
  assert.equal(storage.login, VIEWER);

  const rejected = loadBackground({ token: null, handler: () => [401, { message: "Bad credentials" }] });
  await rejectsWith(rejected.api.saveToken("ghp_bad"), "TOKEN_INVALID");
  assert.equal(rejected.storage.token, undefined, "a rejected token is not stored");
}

console.log("api actions: ok");
