"use strict";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_APPROVE_ALL = 25;
const MERGE_POLL_TIMEOUT_MS = 60_000;
const MERGE_POLL_INTERVAL_MS = 1_500;
const MERGE_STATE_RETRIES = 3;
const MERGE_STATE_RETRY_MS = 1_000;
const MERGE_METHODS = new Set(["MERGE", "SQUASH", "REBASE"]);

const PULL_FIELDS = `
  fragment PullFields on PullRequest {
    id
    number
    title
    url
    state
    isDraft
    headRefName
    baseRefName
    headRefOid
    author { login }
    reviewDecision
    mergeStateStatus
    isMergeQueueEnabled
    latestOpinionatedReviews(first: 100) {
      nodes { author { login } state commit { oid } }
    }
    commits(last: 1) {
      nodes { commit { statusCheckRollup { state } } }
    }
  }
`;

const STACK_QUERY = `
  query StackActions($owner: String!, $repo: String!, $number: Int!) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      pullRequest(number: $number) {
        ...PullFields
        stack {
          baseRefName
          entries(first: 100) {
            nodes { position pullRequest { ...PullFields } }
          }
        }
      }
    }
  }
  ${PULL_FIELDS}
`;

const APPROVE_MUTATION = `
  mutation ApprovePull($pullRequestId: ID!, $commitOID: GitObjectID!) {
    addPullRequestReview(
      input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: APPROVE }
    ) {
      pullRequestReview { url state commit { oid } }
    }
  }
`;

const VIEWER_QUERY = "query Viewer { viewer { login } }";

class GitHubError extends Error {
  constructor(message, code = "GITHUB_ERROR", details = {}) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertCoordinates(owner, repo, number) {
  const safePart = /^[A-Za-z0-9_.-]+$/;
  if (!safePart.test(owner) || !safePart.test(repo)) {
    throw new GitHubError("Invalid repository coordinates.", "INVALID_REQUEST");
  }
  const parsedNumber = Number(number);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new GitHubError("Invalid pull-request number.", "INVALID_REQUEST");
  }
  return parsedNumber;
}

function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha || "")) {
    throw new GitHubError("A full expected head SHA is required.", "INVALID_REQUEST");
  }
}

async function storedToken() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    throw new GitHubError(
      "Add a GitHub personal access token in the extension settings.",
      "TOKEN_REQUIRED"
    );
  }
  return token;
}

async function githubRequest(token, method, path, body = null, acceptedStatuses = []) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    throw new GitHubError(`Could not reach GitHub: ${error.message}`, "NETWORK_ERROR");
  }
  const payload = await response.json().catch(() => null);
  if (response.ok || acceptedStatuses.includes(response.status)) {
    return { status: response.status, payload };
  }
  if (response.status === 401) {
    throw new GitHubError(
      "GitHub rejected the personal access token. Update it in the extension settings.",
      "TOKEN_INVALID"
    );
  }
  throw new GitHubError(
    payload?.message
      ? `GitHub: ${payload.message}`
      : `GitHub returned HTTP ${response.status}.`,
    `HTTP_${response.status}`
  );
}

async function graphql(token, query, variables = {}) {
  const { payload } = await githubRequest(token, "POST", "/graphql", { query, variables });
  if (payload?.errors?.length) {
    throw new GitHubError(
      `GitHub: ${payload.errors.map((error) => error.message).join(" ")}`,
      payload.errors[0].type || "GRAPHQL_ERROR"
    );
  }
  if (!payload?.data) {
    throw new GitHubError("GitHub returned an empty GraphQL response.", "GRAPHQL_ERROR");
  }
  return payload.data;
}

function sameLogin(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function mergeStatus(pull) {
  if (pull.state === "MERGED") return { state: "merged", blocker: null };
  if (pull.state !== "OPEN") return { state: "closed", blocker: null };
  if (pull.isDraft) {
    return { state: "draft", blocker: "Draft pull requests cannot be merged." };
  }
  const checks = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  switch (pull.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return { state: "mergeable", blocker: null };
    case "DIRTY":
      return { state: "conflicts", blocker: "The head branch has merge conflicts with its base." };
    case "BEHIND":
      return { state: "behind", blocker: "The head branch is out of date with its base." };
    case "BLOCKED":
      if (pull.reviewDecision === "CHANGES_REQUESTED") {
        return { state: "changes requested", blocker: "A reviewer requested changes." };
      }
      if (pull.reviewDecision === "REVIEW_REQUIRED") {
        return {
          state: "approval required",
          blocker: "GitHub requires an approving review before this PR can merge.",
        };
      }
      if (checks === "PENDING" || checks === "EXPECTED") {
        return {
          state: "checks pending",
          blocker: "GitHub is waiting for required checks to complete.",
        };
      }
      if (checks === "FAILURE" || checks === "ERROR") {
        return { state: "checks failing", blocker: "Required checks are failing." };
      }
      return {
        state: "blocked",
        blocker: "GitHub reports that merging is blocked, for example by unresolved conversations.",
      };
    default:
      return {
        state: "checking",
        blocker: "GitHub is still computing mergeability. Refresh in a moment.",
      };
  }
}

function approvalStatus(pull, viewer) {
  const review = pull.latestOpinionatedReviews?.nodes?.find((node) =>
    sameLogin(node?.author?.login, viewer)
  );
  if (review?.state === "APPROVED" && review.commit?.oid === pull.headRefOid) return "approved";
  if (pull.state !== "OPEN" || pull.isDraft) return "unavailable";
  if (sameLogin(pull.author?.login, viewer)) return "author";
  return review?.state === "APPROVED" ? "stale" : "pending";
}

function summarizeStack(data, number) {
  const viewer = data.viewer?.login;
  const repository = data.repository;
  const current = repository?.pullRequest;
  if (!viewer || !current) {
    throw new GitHubError(
      `GitHub did not return PR #${number}. Check that the token can read this repository.`,
      "NOT_FOUND"
    );
  }
  const stack = current.stack;
  const pulls = stack
    ? stack.entries.nodes
        .filter((entry) => entry?.pullRequest)
        .sort((a, b) => a.position - b.position)
        .map((entry) => entry.pullRequest)
    : [current];
  const targetBase = stack ? stack.baseRefName : current.baseRefName;
  const lowestOpen = pulls.find((pull) => pull.state === "OPEN");
  return {
    viewer,
    mergeMethod: MERGE_METHODS.has(repository.viewerDefaultMergeMethod)
      ? repository.viewerDefaultMergeMethod
      : "MERGE",
    isStack: Boolean(stack),
    stack: pulls.map((pull) => {
      const approval = approvalStatus(pull, viewer);
      const merge = mergeStatus(pull);
      return {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        url: pull.url,
        state: pull.state,
        draft: pull.isDraft,
        author: pull.author?.login || "ghost",
        headRef: pull.headRefName,
        baseRef: pull.baseRefName,
        headSha: pull.headRefOid,
        approval,
        viewerCanApprove: approval === "pending" || approval === "stale",
        mergeState: merge.state,
        mergeBlocker: merge.blocker,
        mergeQueue: Boolean(pull.isMergeQueueEnabled),
        mergeTarget: pull === lowestOpen && pull.baseRefName === targetBase,
      };
    }),
  };
}

async function loadStack(message, token) {
  const number = assertCoordinates(message.owner, message.repo, message.number);
  // GitHub computes mergeStateStatus lazily: the first read often returns UNKNOWN.
  for (let attempt = 0; ; attempt += 1) {
    const data = await graphql(token, STACK_QUERY, {
      owner: message.owner,
      repo: message.repo,
      number,
    });
    const snapshot = summarizeStack(data, number);
    const settled = !snapshot.stack.some((pull) => pull.mergeState === "checking");
    if (settled || attempt >= MERGE_STATE_RETRIES) return snapshot;
    await sleep(MERGE_STATE_RETRY_MS);
  }
}

async function livePull(message, token) {
  assertSha(message.expectedSha);
  const snapshot = await loadStack(message, token);
  const pull = snapshot.stack.find((entry) => entry.number === Number(message.number));
  if (!pull) {
    throw new GitHubError(`GitHub did not return PR #${message.number}.`, "NOT_FOUND");
  }
  if (pull.headSha !== message.expectedSha) {
    throw new GitHubError(
      `#${pull.number} changed from ${message.expectedSha.slice(0, 7)} to ${pull.headSha.slice(0, 7)}. Refresh and review the new head first.`,
      "HEAD_CHANGED",
      { actualSha: pull.headSha }
    );
  }
  return { snapshot, pull };
}

function approvalRefusal(pull) {
  switch (pull.approval) {
    case "approved":
      return `You already approved #${pull.number} at this commit.`;
    case "author":
      return `GitHub does not let you approve your own PR #${pull.number}.`;
    default:
      return `#${pull.number} is not open for review.`;
  }
}

async function approvePull(message, token) {
  const { snapshot, pull } = await livePull(message, token);
  if (!pull.viewerCanApprove) {
    throw new GitHubError(approvalRefusal(pull), "APPROVAL_UNAVAILABLE");
  }
  const data = await graphql(token, APPROVE_MUTATION, {
    pullRequestId: pull.id,
    commitOID: pull.headSha,
  });
  const review = data.addPullRequestReview?.pullRequestReview;
  if (review?.state !== "APPROVED") {
    throw new GitHubError(
      `GitHub did not record an approval for #${pull.number}.`,
      "APPROVAL_NOT_RECORDED"
    );
  }
  return {
    action: "approved",
    number: pull.number,
    headSha: review.commit?.oid || pull.headSha,
    reviewUrl: review.url,
    viewer: snapshot.viewer,
  };
}

async function approveAll(message, token) {
  if (!Array.isArray(message.pulls) || message.pulls.length === 0) {
    throw new GitHubError("No pull requests were supplied.", "INVALID_REQUEST");
  }
  if (message.pulls.length > MAX_APPROVE_ALL) {
    throw new GitHubError(
      `Approve all is limited to ${MAX_APPROVE_ALL} PRs per action.`,
      "INVALID_REQUEST"
    );
  }

  const results = [];
  for (const pull of message.pulls) {
    try {
      const result = await approvePull(
        {
          owner: message.owner,
          repo: message.repo,
          number: pull.number,
          expectedSha: pull.expectedSha,
        },
        token
      );
      results.push({ ok: true, ...result });
    } catch (error) {
      results.push({
        ok: false,
        number: Number(pull.number),
        error: serializeError(error),
      });
    }
  }
  return { results };
}

async function mergePull(message, token) {
  const { snapshot, pull } = await livePull(message, token);
  if (!pull.mergeTarget) {
    throw new GitHubError(
      `#${pull.number} is not the base-most open PR in its stack. Merge the lower entries first and refresh.`,
      "STACK_ORDER"
    );
  }
  if (pull.mergeState !== "mergeable") {
    throw new GitHubError(
      `${pull.mergeBlocker || "GitHub does not report this PR as mergeable."} No merge was attempted for #${pull.number}.`,
      "MERGE_BLOCKED",
      { mergeState: pull.mergeState }
    );
  }

  const path = `/repos/${encodeURIComponent(message.owner)}/${encodeURIComponent(message.repo)}/pulls/${pull.number}/merge-async`;
  const body = { sha: pull.headSha, merge_action: "default" };
  if (!pull.mergeQueue) body.merge_method = snapshot.mergeMethod.toLowerCase();
  // 400 carries a "failed" result and 409 returns the merge request already in flight.
  let { payload } = await githubRequest(token, "PUT", path, body, [400, 409]);

  const deadline = Date.now() + MERGE_POLL_TIMEOUT_MS;
  while (payload?.status === "pending" && payload.details?.uuid && Date.now() < deadline) {
    await sleep(MERGE_POLL_INTERVAL_MS);
    ({ payload } = await githubRequest(
      token,
      "GET",
      `${path}/${encodeURIComponent(payload.details.uuid)}`
    ));
  }

  switch (payload?.status) {
    case "merged":
      return {
        action: "merged",
        number: pull.number,
        headSha: pull.headSha,
        mergeSha: payload.details?.sha || null,
      };
    case "enqueued":
      return { action: "enqueued", number: pull.number, headSha: pull.headSha };
    case "failed":
      throw new GitHubError(
        `GitHub could not merge #${pull.number}: ${payload.details?.message || "no reason given"}`,
        "MERGE_FAILED"
      );
    case "pending":
      throw new GitHubError(
        `GitHub accepted the merge for #${pull.number} but has not finished it. Refresh in a moment.`,
        "MERGE_PENDING"
      );
    default:
      throw new GitHubError(
        `GitHub returned an unexpected merge response for #${pull.number}.`,
        "MERGE_UNKNOWN"
      );
  }
}

async function saveToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) throw new GitHubError("Paste a token first.", "INVALID_REQUEST");
  const data = await graphql(token, VIEWER_QUERY);
  await chrome.storage.local.set({ token, login: data.viewer.login });
  return { login: data.viewer.login };
}

async function tokenStatus() {
  const { token, login } = await chrome.storage.local.get(["token", "login"]);
  return { configured: Boolean(token), login: login || null };
}

async function clearToken() {
  await chrome.storage.local.remove(["token", "login"]);
  return { cleared: true };
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || "UNEXPECTED_ERROR",
    details: error?.details || {},
  };
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "load-stack":
        return loadStack(message, await storedToken());
      case "approve":
        return approvePull(message, await storedToken());
      case "approve-all":
        return approveAll(message, await storedToken());
      case "merge":
        return mergePull(message, await storedToken());
      case "token-status":
        return tokenStatus();
      case "save-token":
        return saveToken(message.token);
      case "clear-token":
        return clearToken();
      case "open-settings":
        await chrome.runtime.openOptionsPage();
        return { opened: true };
      default:
        throw new GitHubError("Unknown extension request.", "INVALID_REQUEST");
    }
  };

  run()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});
