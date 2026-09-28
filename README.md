# GitHub PR Shortcuts

This Manifest V3 Chrome extension adds approval and stack controls to GitHub pull-request pages. It calls the GitHub API with a personal access token (PAT), so the PR page never navigates and no hidden tabs are opened.

## Authentication

Open the extension settings (click the toolbar icon) and paste a PAT. The extension verifies it with GitHub, then keeps it in `chrome.storage.local` for this Chrome profile. Only the background service worker reads the token, and it sends the token only to `api.github.com`. Approvals and merges are made as the token's owner.

**Fine-grained token:** set the organization as resource owner, give it access to the repositories you review, and grant these repository permissions:

- Pull requests: Read and write, to read stacks and approve.
- Contents: Read and write, to merge.
- Metadata: Read, which GitHub adds automatically.

An organization admin may need to approve the token.

**Classic token:** use the `repo` scope, then authorize it with **Configure SSO** for any SAML-protected organization.

## Features

- A split **Approve PR** button on GitHub PR pages.
- Stack discovery from GitHub's native stack API (`PullRequest.stack`), ordered from the base PR to the tip.
- Head SHA, branches, your approval status, and merge state for every entry. An approval on an older commit is flagged and can be renewed.
- Individual **Approve** controls, plus **Approve all** with confirmation and per-PR partial-success reporting.
- A base-first **Merge** control for the lowest open stack entry.
- Merge buttons stay disabled while GitHub reports a required approval, requested changes, pending or failing checks, conflicts, an out-of-date branch, or another blocker. The reason is shown in the PR row.

## Approval contract

For every approval, the extension:

1. re-reads the PR and stops if the head SHA differs from the one you saw;
2. refuses PRs you authored, PRs you already approved at this head, drafts, and closed PRs;
3. submits `addPullRequestReview` with `event: APPROVE` and `commitOID` set to that head SHA; and
4. reports success only when GitHub returns an `APPROVED` review.

**Approve all** runs this sequence separately for every eligible PR. It is deliberately non-atomic and reports each success or failure.

## Merge contract

For a merge, the extension:

1. confirms the repository, PR, head SHA, and merge method with you;
2. re-reads the stack and stops if the head SHA changed, the PR is not the lowest open entry targeting the stack's base branch, or GitHub does not report it as mergeable;
3. calls `PUT /repos/{owner}/{repo}/pulls/{number}/merge-async` with `sha` set to the expected head, so GitHub cancels the merge if the branch moves; and
4. polls the async merge result until GitHub reports it merged, enqueued, or failed.

The merge method is your last-used method for the repository (GitHub's `viewerDefaultMergeMethod`). When the base branch has a merge queue, the PR is added to the queue and GitHub picks the method.

There is no **Merge all** action. GitHub's async merge would merge every entry up to the selected one, so only the base-most open entry is offered and each merge needs a fresh, explicit action.

## Install

1. Clone the repository: `git clone https://github.com/sour4bh/ghpr-shortcuts.git`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `ghpr-shortcuts` directory.
6. Click the extension's toolbar icon and save a token.
7. Open or reload a GitHub PR page.

To update, run `git pull` and click the reload icon on the extension's card at `chrome://extensions`. Until you reload, Chrome keeps running the previous background worker.

## Permissions

- `storage`: keep the token and its login in `chrome.storage.local`.
- Host access to `https://api.github.com/*`: GraphQL reads, approvals, and merges.
- Content script on `https://github.com/*`: show the controls on PR pages, including pages reached through GitHub's in-app navigation. The script reads only the PR coordinates from the URL.

## Development checks

```sh
node --check background.js
node --check content.js
node --check options.js
node tests/stack-summary.test.mjs
node tests/api-actions.test.mjs
python -m json.tool manifest.json >/dev/null
```

After modifying the extension, reload it at `chrome://extensions` and reload the GitHub PR page.
