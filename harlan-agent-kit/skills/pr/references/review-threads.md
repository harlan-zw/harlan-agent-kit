# Review threads

Leave no review comment silent. Each review thread and each top-level review comment gets one response: Fixed, Answered, or Follow-up.

Run this sweep after every push to the pull request. Run it again before you call the pull request ready or hand it back.

## Who may post

- On a repository Harlan owns or maintains, post the self-identified Agent replies below. Resolve the threads they close. No approval is needed.
- On any other repository, draft each reply in the session. Show Harlan the exact text. Do not post or resolve.
- In a Service implementation or Repair Task, `gh` is the read-only public wrapper. It cannot list thread state. Skip this sweep and say so in the Task result. The controller owns GitHub writes.

## 1. List every item

`agent-gh` cannot read thread state. `pr view --json` has no review threads, the REST review comment list has no resolved field, and `agent-gh` refuses raw GraphQL.
The `github-read-routing` Hook allows `gh api graphql` only with an explicit `-X POST`, so this list uses Harlan's `gh` credentials. Use it only for the pull request you deliver. Use `agent-gh` for every other public read.

```bash
query='query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated path line
        root: comments(first: 1) { nodes { fullDatabaseId url author { login } body } }
        latest: comments(last: 100) { totalCount nodes { fullDatabaseId author { login } body } } } } } } }'
gh api graphql -X POST --paginate -f query="$query" -f owner=OWNER -f repo=REPO -F number=NUMBER \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | .root.nodes[0] as $root
    | {thread: .id, comment: $root.fullDatabaseId, author: $root.author.login, comments: .latest.totalCount,
       replies: [.latest.nodes[] | select(.fullDatabaseId != $root.fullDatabaseId)
         | {author: .author.login, first: (.body | split("\n")[0] | .[0:120])}],
       outdated: .isOutdated, path, line, url: $root.url, first: ($root.body | .[0:300])}'
```

GraphQL drops the `[bot]` suffix, so the Service shows as `harlan-github-agent`.
`replies` holds the last 100 replies. `comments` counts every comment in the thread.
The list shows only the start of each body. Read the full body of each item before you choose its response.
An outdated thread still needs a response. The code moved, and the comment can still apply.

An Agent reply comes from the login that `gh api user --jq .login` prints, and its body starts with `🤖 Harlan Agent Kit Agent:`.
Count a reply as the thread's response only when both match. If the last reply is an Agent reply, the thread already has its response.
If such a thread is still open, resolve it again only when this session saw its resolve command fail.
Otherwise a reviewer reopened it. Read the thread again and give it a new response.

List top-level reviews and comments. For a verified private repository, use `HARLAN_AGENT_GITHUB_PRIVATE=OWNER/REPO gh` in place of `agent-gh`.

```bash
agent-gh api repos/OWNER/REPO/pulls/NUMBER/reviews --paginate \
  --jq '.[] | select(.body != "") | {author: .user.login, state, commit: .commit_id, url: .html_url, first: (.body | .[0:200])}'
agent-gh api repos/OWNER/REPO/issues/NUMBER/comments --paginate \
  --jq '.[] | {author: .user.login, url: .html_url, first: (.body | .[0:200])}'
```

Skip the pull request author's own comments and the Service's marked comment.
Also skip status bots that ask for no change, such as build size and preview reports.
A review body from another reviewer needs a response once, even when it is on an older head. CodeRabbit puts outside-diff comments and nitpicks in its review body.

## 2. Service finding threads

The Service owns each review thread it opened for a Review finding. Its first comment carries a `review-finding:` marker. Two side effects limit what you may do on it while the pull request is open:

- A reply from Harlan's account is a finding reply. The Service requests a Review of the current revision for it, and that Review reads the reply as Harlan's words.
  If that revision's Review is `Queued` or `Running`, the request joins it. If that Review has ended, the request starts another one.
- Resolving a Logged finding thread dismisses its "Ask an agent to verify and fix" control. The Service ignores a later tick and cancels a queued Repair for that finding.

Never resolve a Service finding thread during this sweep. The Service verifies the fix and resolves the thread.
Keep the thread open even when your push attempts to fix it. Review may report the same finding again.
Include the fixing commit and thread link in the hand-back while verification is pending.

Reply to a Service finding thread only in one window. It opens when you push the commit that fixes the finding.
It stays open while the Service Review of that new head is `Queued` or `Running`.
The first event that `watch-pr` writes names the head the Service sees and that head's Tasks:

```bash
harlan-github-agent control watch-pr --repository OWNER/REPO --number NUMBER --until review --timeout-seconds 60 2>&1 >/dev/null \
  | head -1 | jq '{headSha, tasks: [.tasks[] | {kind, state}]}'
```

Continue only when `headSha` is your pushed SHA and the `adversarial_review` Task is `Queued` or `Running`.
In that window, post only the Fixed reply from section 3. Leave the thread open for Service verification.
A Follow-up reply is also allowed in the window. Leave that thread open, because its control holds the follow-up.
Outside the window, do not reply. Name the commit or the follow-up in the hand-back.

This sweep only reports Service findings. It grants no Repair authority, regardless of impact.
List each finding and its thread link for Step 6's disposition and Task ownership checks.
If those checks are unavailable, report the missing Service state and do not edit or push for the finding.

- **Dismissal:** report it through Step 6. Do not repair or request another Review.
- **Repair:** use Step 6's authority checks before editing or pushing. Leave a current-head `Queued`, `Running`, or `Publishing` Repair Task to the Service.
- **80/100 or below (Logged):** list it as optional follow-up in the hand-back. Harlan ticks its control or resolves it.
  If a Logged finding has no thread, list it with a link to the Service's marked comment. A finding outside the diff never has one, and a failed thread sync can leave out others.
- **Fixed by your push:** reply in the window above and leave the thread open for Service verification.
  Include the fixing commit and thread link in the hand-back while verification is pending, even after replying.
  If you missed the window, do not reply. Name the commit in the hand-back.
- **False positive or not applicable:** use Step 6's evidence and comment procedure.

After an authorized Repair, the next Service Review resolves the thread when the finding clears. Confirm that it did.
If Review reports the same finding, leave its thread and Repair control open.

## 3. Every other item

| Response | Reply | Resolve |
| --- | --- | --- |
| Fixed | `🤖 Harlan Agent Kit Agent: fixed in [abc1234](https://github.com/OWNER/REPO/commit/FULL_SHA).` | Yes |
| Answered | `🤖 Harlan Agent Kit Agent: not changed. EVIDENCE.` Give the proof in one or two sentences. | A bot's thread only |
| Follow-up | `🤖 Harlan Agent Kit Agent: optional follow-up, not changed in this pull request. REASON or ISSUE_LINK.` | A bot's thread only |

Push the fixing commit before the reply names it. Use the short SHA as the link text and the full SHA in the link.
Leave a human reviewer's thread open after Answered or Follow-up. That reviewer decides whether the answer is enough.
If a bot reviewer already marked its comment addressed and resolved the thread, it needs nothing more. CodeRabbit writes "✅ Addressed in commit".
A reply to CodeRabbit makes it answer. Post one reply per thread.

Reply on the thread. Just before you resolve it, run the list again. If a comment arrived after your reply, respond to it first.
The `&&` runs the resolve only after the reply succeeds:

```bash
gh api -X POST repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_ID/replies \
  -f body='🤖 Harlan Agent Kit Agent: fixed in [abc1234](https://github.com/OWNER/REPO/commit/FULL_SHA).' && \
gh api graphql -X POST \
  -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' \
  -f id=THREAD_ID --jq .data.resolveReviewThread.thread.isResolved
```

`COMMENT_ID` is the first comment's `fullDatabaseId`. Preserve its complete decimal string in the REST path.
Do not convert it to a 32-bit integer or a JavaScript number.
`THREAD_ID` is the `PRRT_` ID. Both come from the list.
The resolve command prints `true` when GitHub resolved the thread.
If either command fails, the thread stays open. Report the error. Never retry it with other credentials or another tool.
This applies to every response that resolves a thread: Fixed, and Answered or Follow-up on a bot's thread.

Answer top-level items in one comment. Link each item it answers.

```bash
gh pr comment NUMBER --repo OWNER/REPO --body '🤖 Harlan Agent Kit Agent: ...'
```

## 4. Check the result

Run the list again. Each unresolved thread must be one of these:

- a Service finding thread that the hand-back lists
- a thread with an Agent reply from this sweep
- a human reviewer's thread that waits for that reviewer
- on a repository Harlan does not maintain, a thread whose drafted reply waits for Harlan

Each top-level item from another reviewer must have an Agent answer or a drafted answer.
Put the exact text of each draft in the hand-back. Report the counts there: Fixed, Answered, Follow-up, waiting, and drafted.
