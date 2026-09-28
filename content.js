"use strict";

(() => {
  const HOST_ID = "ghpr-shortcuts-root";
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
  const TOKEN_ERRORS = new Set(["TOKEN_REQUIRED", "TOKEN_INVALID"]);
  const METHOD_LABELS = { MERGE: "merge commit", SQUASH: "squash", REBASE: "rebase" };

  function extensionError(message, code = "EXTENSION_ERROR", details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function coordinates() {
    const match = window.location.pathname.match(PR_PATH);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  }

  let routeKey = "";
  let host = null;
  let shadow = null;
  let routeCheckQueued = false;
  let state = initialState();

  function initialState() {
    return {
      coordinates: null,
      data: null,
      loading: true,
      busy: false,
      panelOpen: false,
      error: null,
    };
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(extensionError(chrome.runtime.lastError.message, "RUNTIME_ERROR"));
          return;
        }
        if (!response?.ok) {
          const error = response?.error || {};
          reject(extensionError(error.message || "Extension request failed.", error.code, error.details));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function tokenError() {
    return TOKEN_ERRORS.has(state.error?.code);
  }

  function ensureHost() {
    if (host?.isConnected && shadow) return;
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "fixed";
    host.style.right = "20px";
    host.style.bottom = "20px";
    host.style.zIndex = "2147483600";
    shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
  }

  function styleText() {
    return `
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      .shell { position: relative; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
      .split { display: flex; justify-content: flex-end; filter: drop-shadow(0 6px 16px rgba(31,35,40,.22)); }
      button { font: inherit; }
      .primary,.toggle,.small,.footer-button,.about { border: 1px solid rgba(31,35,40,.18); cursor: pointer; font-weight: 600; }
      .primary { min-width: 132px; padding: 9px 13px; color: #fff; background: #1f883d; border-radius: 7px 0 0 7px; }
      .primary:hover:not(:disabled),.small.approve:hover:not(:disabled),.footer-button:hover:not(:disabled) { background: #1a7f37; }
      .toggle { width: 38px; color: #fff; background: #1f883d; border-left-color: rgba(255,255,255,.25); border-radius: 0 7px 7px 0; }
      button:disabled { cursor: default; opacity: .55; }
      .panel { position: absolute; right: 0; bottom: 48px; width: min(550px,calc(100vw - 32px)); max-height: min(680px,calc(100vh - 100px)); display:flex; flex-direction:column; overflow:hidden; background:#fff; border:1px solid #d0d7de; border-radius:10px; box-shadow:0 12px 32px rgba(31,35,40,.24); }
      .header { padding:14px 16px 12px; border-bottom:1px solid #d8dee4; }
      .header-top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .title { font-size:15px; font-weight:700; }
      .subtitle { margin-top:3px; color:#656d76; font-size:12px; }
      .about { padding:5px 8px; color:#1f2328; background:#f6f8fa; border-radius:6px; }
      .body { overflow:auto; }
      .message { padding:18px 16px; color:#656d76; }
      .message.error { color:#cf222e; }
      .row { padding:12px 14px; border-bottom:1px solid #d8dee4; }
      .row.current { background:#f0f7ff; box-shadow:inset 3px 0 #0969da; }
      .row-head { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
      .pr-info { min-width:0; flex:1; }
      .pr-link { color:#0969da; font-weight:650; text-decoration:none; }
      .pr-link:hover { text-decoration:underline; }
      .pr-title { margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
      .branches { margin-top:4px; overflow:hidden; color:#656d76; font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
      .blocker { margin-top:7px; color:#8c5b00; font-size:11px; }
      .chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
      .chip { padding:2px 6px; border-radius:999px; color:#656d76; background:#f6f8fa; border:1px solid #d8dee4; font-size:11px; }
      .chip.good { color:#116329; background:#dafbe1; border-color:#aceebb; }
      .chip.warn { color:#7d4e00; background:#fff8c5; border-color:#eac54f; }
      .chip.bad { color:#82071e; background:#ffebe9; border-color:#ffcecb; }
      .actions { display:flex; gap:6px; flex:none; }
      .small { padding:5px 9px; border-radius:6px; }
      .small.approve { color:#fff; background:#1f883d; }
      .small.merge { color:#fff; background:#8250df; }
      .footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; background:#f6f8fa; }
      .footer-note { min-width:0; color:#656d76; font-size:11px; }
      .footer-button { flex:none; padding:7px 11px; color:#fff; background:#1f883d; border-radius:6px; }
      .toast { position:absolute; right:0; bottom:48px; width:min(440px,calc(100vw - 32px)); padding:11px 13px; color:#fff; background:#1f6f33; border:1px solid #2ea043; border-radius:8px; box-shadow:0 8px 24px rgba(31,35,40,.24); }
      .toast.error { background:#8e1519; border-color:#f85149; }
      @media (prefers-color-scheme: dark) {
        .shell { color:#f0f6fc; }.panel { background:#0d1117; border-color:#30363d; }.header,.row { border-color:#30363d; }.subtitle,.message,.branches,.footer-note { color:#8b949e; }.blocker { color:#d29922; }.about,.footer { color:#f0f6fc; background:#161b22; border-color:#30363d; }.row.current { background:#0c2d48; }.chip { color:#8b949e; background:#161b22; border-color:#30363d; }
      }
    `;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadData() {
    return send({ type: "load-stack", ...state.coordinates });
  }

  function currentPull() {
    return state.data?.stack.find((pull) => pull.number === state.coordinates?.number);
  }

  function pendingApprovals() {
    return state.data.stack.filter((pull) => pull.viewerCanApprove);
  }

  function methodLabel() {
    return METHOD_LABELS[state.data?.mergeMethod] || "merge commit";
  }

  function approvalChip(pull) {
    switch (pull.approval) {
      case "approved":
        return '<span class="chip good">approved by you</span>';
      case "stale":
        return '<span class="chip warn">you approved an older commit</span>';
      case "pending":
        return '<span class="chip">not approved by you</span>';
      case "author":
        return '<span class="chip warn">your PR</span>';
      default:
        return "";
    }
  }

  function mergeChipClass(value) {
    if (value === "mergeable" || value === "merged") return "good";
    if (["conflicts", "changes requested", "checks failing", "blocked"].includes(value)) return "bad";
    return "warn";
  }

  function mainLabel() {
    if (state.loading) return "Loading…";
    if (state.busy) return "Working…";
    if (tokenError()) return "Set up token";
    if (state.error) return "Unavailable";
    const pull = currentPull();
    if (pull?.approval === "approved") return "Approved ✓";
    if (pull?.approval === "author") return "Your PR";
    if (!pull?.viewerCanApprove) return "Unavailable";
    return "Approve PR";
  }

  function mergeTitle(pull) {
    if (pull.state !== "OPEN") return "";
    if (!pull.mergeTarget) return "Merge the lower stack entries first, then refresh";
    if (pull.mergeBlocker) return pull.mergeBlocker;
    return pull.mergeQueue ? "Add to GitHub's merge queue" : `Merge with ${methodLabel()}`;
  }

  function rowHtml(pull, index) {
    const isCurrent = pull.number === state.coordinates.number;
    const approveDisabled = state.busy || !pull.viewerCanApprove;
    const mergeDisabled = state.busy || !pull.mergeTarget || pull.mergeState !== "mergeable";
    return `
      <div class="row${isCurrent ? " current" : ""}">
        <div class="row-head">
          <div class="pr-info">
            <a class="pr-link" href="${escapeHtml(pull.url)}">#${pull.number}</a>
            <div class="pr-title" title="${escapeHtml(pull.title)}">${escapeHtml(pull.title)}</div>
            <div class="branches">${escapeHtml(pull.baseRef)} ← ${escapeHtml(pull.headRef)}</div>
            <div class="chips">
              <span class="chip">${index + 1}/${state.data.stack.length}</span>
              <span class="chip">${pull.headSha.slice(0, 7)}</span>
              ${approvalChip(pull)}
              <span class="chip ${mergeChipClass(pull.mergeState)}">${escapeHtml(pull.mergeState)}</span>
            </div>
            ${pull.mergeBlocker ? `<div class="blocker">${escapeHtml(pull.mergeBlocker)}</div>` : ""}
          </div>
          <div class="actions">
            <button class="small approve" data-approve="${pull.number}" ${approveDisabled ? "disabled" : ""}>Approve</button>
            <button class="small merge" data-merge="${pull.number}" ${mergeDisabled ? "disabled" : ""} title="${escapeHtml(mergeTitle(pull))}">Merge</button>
          </div>
        </div>
      </div>`;
  }

  function panelHtml() {
    if (!state.panelOpen) return "";
    let body;
    let footer = "";
    if (state.loading) {
      body = '<div class="message">Reading the PR and its stack from GitHub…</div>';
    } else if (state.error) {
      body = `<div class="message error">${escapeHtml(state.error.message)}</div>`;
    } else {
      body = state.data.stack.map(rowHtml).join("");
      const pending = pendingApprovals();
      footer = `<div class="footer"><div class="footer-note">Actions use your GitHub token and are pinned to the head SHA shown. Merge unlocks base-first.</div><button class="footer-button" id="approve-all" ${state.busy || !pending.length ? "disabled" : ""}>Approve all (${pending.length})</button></div>`;
    }
    return `<div class="panel"><div class="header"><div class="header-top"><div><div class="title">${state.data?.isStack ? `PR stack · ${state.data.stack.length} entries` : "Pull request actions"}</div><div class="subtitle">GitHub API${state.data?.viewer ? ` · ${escapeHtml(state.data.viewer)}` : ""}</div></div><button class="about" id="settings">Settings</button></div></div><div class="body">${body}</div>${footer}</div>`;
  }

  function render() {
    ensureHost();
    const current = currentPull();
    const mainDisabled =
      state.loading ||
      state.busy ||
      (!tokenError() && (Boolean(state.error) || !current?.viewerCanApprove));
    shadow.innerHTML = `<style>${styleText()}</style><div class="shell">${panelHtml()}<div class="split"><button class="primary" id="primary" ${mainDisabled ? "disabled" : ""}>${mainLabel()}</button><button class="toggle" id="toggle" aria-label="Show PR stack actions" aria-expanded="${state.panelOpen}">▾</button></div></div>`;
    attachHandlers();
  }

  function openSettings() {
    send({ type: "open-settings" }).catch((error) => showToast(error.message, true));
  }

  function attachHandlers() {
    shadow.getElementById("toggle")?.addEventListener("click", () => {
      state.panelOpen = !state.panelOpen;
      render();
    });
    shadow.getElementById("primary")?.addEventListener("click", () => {
      if (tokenError()) {
        openSettings();
        return;
      }
      const pull = currentPull();
      if (pull) approvePull(pull);
    });
    shadow.getElementById("settings")?.addEventListener("click", openSettings);
    shadow.querySelectorAll("[data-approve]").forEach((button) =>
      button.addEventListener("click", () => {
        const pull = state.data.stack.find((item) => item.number === Number(button.dataset.approve));
        if (pull) approvePull(pull);
      })
    );
    shadow.querySelectorAll("[data-merge]").forEach((button) =>
      button.addEventListener("click", () => {
        const pull = state.data.stack.find((item) => item.number === Number(button.dataset.merge));
        if (pull) mergePull(pull);
      })
    );
    shadow.getElementById("approve-all")?.addEventListener("click", approveAll);
  }

  function showToast(message, isError = false) {
    shadow.getElementById("toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "toast";
    toast.className = `toast${isError ? " error" : ""}`;
    toast.setAttribute("role", "status");
    toast.textContent = message;
    shadow.querySelector(".shell")?.appendChild(toast);
    setTimeout(() => toast.remove(), isError ? 10_000 : 6_000);
  }

  async function refresh() {
    state.data = await loadData();
    state.error = null;
  }

  async function runAction(action) {
    state.busy = true;
    render();
    let message = null;
    let failed = false;
    try {
      message = await action();
      await refresh();
    } catch (error) {
      message = error.message;
      failed = true;
    } finally {
      state.busy = false;
      render();
      if (message) showToast(message, failed);
    }
  }

  function approvePull(pull) {
    return runAction(async () => {
      const result = await send({
        type: "approve",
        owner: state.coordinates.owner,
        repo: state.coordinates.repo,
        number: pull.number,
        expectedSha: pull.headSha,
      });
      return `Approved #${pull.number} at ${result.headSha.slice(0, 7)} as ${result.viewer}.`;
    });
  }

  async function approveAll() {
    const pending = pendingApprovals();
    if (!pending.length) return;
    const summary = pending.map((pull) => `#${pull.number} (${pull.headSha.slice(0, 7)})`).join(", ");
    if (!window.confirm(`Approve ${pending.length} PR${pending.length === 1 ? "" : "s"} as ${state.data.viewer}?\n\n${summary}\n\nEach approval is pinned to the head SHA shown and refused if the PR has moved.`)) return;
    return runAction(async () => {
      const result = await send({
        type: "approve-all",
        owner: state.coordinates.owner,
        repo: state.coordinates.repo,
        pulls: pending.map((pull) => ({ number: pull.number, expectedSha: pull.headSha })),
      });
      const succeeded = result.results.filter((entry) => entry.ok);
      const failed = result.results.filter((entry) => !entry.ok);
      if (failed.length) {
        throw extensionError(`${succeeded.length}/${result.results.length} approvals succeeded; ${failed.map((entry) => `#${entry.number}: ${entry.error.message}`).join(" · ")}`, "PARTIAL_FAILURE");
      }
      return `${succeeded.length}/${result.results.length} approvals succeeded.`;
    });
  }

  function mergePull(pull) {
    const target = `${state.coordinates.owner}/${state.coordinates.repo}#${pull.number} at ${pull.headSha.slice(0, 7)}`;
    const prompt = pull.mergeQueue
      ? `Add ${target} to GitHub's merge queue as ${state.data.viewer}?`
      : `Merge ${target} with ${methodLabel()} as ${state.data.viewer}?`;
    if (!window.confirm(`${prompt}\n\nOnly this base-most stack entry is merged. GitHub cancels the merge if the head changes, and branch protection still applies.`)) return;
    return runAction(async () => {
      const result = await send({
        type: "merge",
        owner: state.coordinates.owner,
        repo: state.coordinates.repo,
        number: pull.number,
        expectedSha: pull.headSha,
      });
      return result.action === "enqueued"
        ? `Added #${pull.number} to the merge queue.`
        : `Merged #${pull.number} at ${result.headSha.slice(0, 7)}.`;
    });
  }

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      state.data = await loadData();
    } catch (error) {
      state.data = null;
      state.error = error;
      state.panelOpen = true;
    } finally {
      state.loading = false;
      render();
    }
  }

  function activateRoute() {
    routeCheckQueued = false;
    const next = coordinates();
    const nextKey = next ? `${next.owner}/${next.repo}#${next.number}` : "";
    if (!next) {
      host?.remove(); host = null; shadow = null; routeKey = ""; return;
    }
    ensureHost();
    if (nextKey === routeKey) return;
    routeKey = nextKey;
    state = initialState();
    state.coordinates = next;
    render();
    load();
  }

  function scheduleRouteCheck() {
    if (routeCheckQueued) return;
    routeCheckQueued = true;
    requestAnimationFrame(activateRoute);
  }

  // Retry after the user returns from the settings tab with a new token.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && routeKey && !state.loading && tokenError()) {
      load();
    }
  });
  window.addEventListener("popstate", scheduleRouteCheck);
  document.addEventListener("turbo:load", scheduleRouteCheck);
  new MutationObserver(scheduleRouteCheck).observe(document.documentElement, { childList:true, subtree:true });
  activateRoute();
})();
