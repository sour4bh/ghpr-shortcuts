import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../background.js", import.meta.url), "utf8");

export const VIEWER = "sourabh-sharma_dex";
export const sha = (char) => char.repeat(40);

// Values created inside the vm context carry its prototypes; compare plain copies.
export const plain = (value) => JSON.parse(JSON.stringify(value));

export function pullNode(number, overrides = {}) {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/Delta-Exchange-Org/support-chatbot/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: `branch-${number}`,
    baseRefName: "develop",
    headRefOid: sha("a"),
    author: { login: "someone-else" },
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    isMergeQueueEnabled: false,
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

export function stackData(current, entries = null, mergeMethod = "SQUASH") {
  return {
    viewer: { login: VIEWER },
    repository: {
      viewerDefaultMergeMethod: mergeMethod,
      pullRequest: {
        ...current,
        stack: entries
          ? {
              baseRefName: "develop",
              entries: {
                nodes: entries.map((pullRequest, index) => ({ position: index + 1, pullRequest })),
              },
            }
          : null,
      },
    },
  };
}

// Loads background.js with a fake chrome API and a fetch routed through `handler`.
// `handler({ url, method, body })` returns `[status, payload]`.
export function loadBackground({ token = "ghp_test", handler = () => [500, null] } = {}) {
  const storage = token ? { token } : {};
  const requests = [];
  const pick = (keys) =>
    Object.fromEntries([keys].flat().filter((key) => key in storage).map((key) => [key, storage[key]]));
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, openOptionsPage: async () => {} },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (values) => Object.assign(storage, values),
        remove: async (keys) => [keys].flat().forEach((key) => delete storage[key]),
      },
    },
  };
  const fetch = async (url, init) => {
    const request = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    const [status, payload] = await handler(request);
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  const context = vm.createContext({
    chrome,
    fetch,
    encodeURIComponent,
    setTimeout: (callback) => setTimeout(callback, 0),
    result: null,
  });
  vm.runInContext(
    `${source}\nresult = { loadStack, approvePull, approveAll, mergePull, summarizeStack, mergeStatus, storedToken, saveToken };`,
    context,
    { filename: "background.js" }
  );
  return { api: context.result, requests, storage };
}

export async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected rejection with ${code}`);
}
