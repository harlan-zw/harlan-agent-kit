# Review threads

Leave no review comment silent. Each review thread and each top-level review comment gets one response: Fixed, Answered, or Follow-up.
Service finding threads follow section 2.
Write every reply to the [comment voice](../../../references/comment-voice.md#thread-replies) contract.

Run this sweep after every push to the pull request. Run it again before you call the pull request ready or hand it back.

## Work only what matters

The sweep exists so nothing stays silent. It does not exist to implement every suggestion.

- Fix a finding only when it scores above 80/100, or when you can show the defect with a failing command, test, or reproduction.
- Close other reviewers' low-value bot threads with one Follow-up reply, then resolve the thread.
  This covers findings at 80/100 or below, style, wording, and nitpicks.
  Service finding threads stay open under section 2, including unchecked Logged controls.
- Never change code or push a commit for a low-value thread.
- Each fix commit counts toward Step 6's limit of three review-driven pushes.

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
       finding: ($root.body | [scan("review-finding: ([a-f0-9]{64})")[0]] | first),
       selected: ($root.body | test("(?m)^ *(- \\[[xX]\\] Ask an agent to verify and fix this finding|Repair: )")),
       replies: [.latest.nodes[] | select(.fullDatabaseId != $root.fullDatabaseId)
         | {author: .author.login, first: (.body | split("\n")[0] | .[0:120])}],
       outdated: .isOutdated, path, line, url: $root.url, first: ($root.body | .[0:300])}'
```

GraphQL drops the `[bot]` suffix. Identify Service finding threads by their `review-finding:` marker, regardless of actor login.
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

The Service owns each review thread it opened for a Review finding. Its first comment carries a `review-finding:` marker. Two side effects shape what you do on it while the pull request is open:

- A reply from Harlan's account is a finding reply. The Service requests a Review of the current revision for it, and that Review reads the reply as Harlan's words.
  If that revision's Review is `Queued` or `Running`, the request joins it. If that Review has ended, the request starts another one.
- Resolving a Logged finding thread dismisses its "Ask an agent to verify and fix" control.
  The Service cancels its Repair, including `Queued`, `Running`, and `Publishing` work.
  Reopening the thread does not restore the selection.

Never resolve a Service finding thread during an automatic sweep.
Keep unchecked controls open so Harlan can select a Repair after hand-back.
A selection can arrive after any read. GitHub's resolve mutation cannot check that the control remains unchecked.
Another read cannot make that mutation safe.

Selection evidence is for reporting only. It never permits automatic resolution.
Use Step 6's trusted canonical comment and repository read route when reporting Repair status.
Do not assume one actor login. If selection evidence is unavailable, report it as unknown and keep the thread open.
No canonical comment lookup is needed to decide whether a Service thread stays open.

The sweep grants no Repair authority. Handle each Service finding by its score:

- **Above 80/100:** use Step 6's disposition and authority checks before editing or pushing. Leave a current-head `Queued`, `Running`, or `Publishing` Repair Task to the Service.
  After your fix, never resolve the thread. The next Service Review resolves it when the finding clears. If Review reports the finding again, leave the thread open.
- **Dismissal:** report it through Step 6. Do not repair or request another Review.
- **False positive or not applicable:** use Step 6's evidence and comment procedure.
- **80/100 or below (Logged), Repair selected:** leave the thread open and the Repair to the Service. List it in the hand-back.
- **80/100 or below (Logged), unchecked or selection unknown:** never change code. Leave the thread and its Repair control open.
  Link each available control in the hand-back. Harlan may select the Repair or explicitly dismiss the finding.
  If a Logged finding has no thread, link its control in the Service's marked comment.

Reply to a Service finding thread only in a window, so the reply joins a Review that is already due.
The window opens when you push. It stays open while the Service Review of that new head is `Queued` or `Running`.
The first event that `watch-pr` writes names the head the Service sees and that head's Tasks:

```bash
harlan-github-agent control watch-pr --repository OWNER/REPO --number NUMBER --until review --timeout-seconds 60 2>&1 >/dev/null \
  | head -1 | jq '{headSha, tasks: [.tasks[] | {kind, state}]}'
```

Continue only when `headSha` is your pushed SHA and the `adversarial_review` Task is `Queued` or `Running`.
In the window, you may post a Follow-up or Fixed reply. Leave every Service finding thread open.
If the thread's Repair is still active, the Follow-up reply is `🤖 Harlan Agent Kit Agent: Repair fixes this in this pull request.`
Active means the control is ticked, or the `Repair:` line reads `Queued.`, a step in progress, or `Publishing the fix.`
Otherwise use a Follow-up form from section 3.
Outside the window, leave Service threads open without a reply. A reply would start another Review.
The finding's own text already marks a Logged finding as an optional follow-up.
In the hand-back, link each unchecked or unknown Repair control, each selected Repair, and each fix awaiting Service verification.
An unchecked Logged control counts as waiting for Harlan. It does not block readiness by itself.
Only Harlan's explicit dismissal or the Service's verified finding lifecycle may close these threads.

## 3. Every other item

| Response | When | Reply | Resolve |
| --- | --- | --- | --- |
| Fixed | Above 80/100, or a defect you can show | `🤖 Harlan Agent Kit Agent: fixed in [abc1234](https://github.com/OWNER/REPO/commit/FULL_SHA): CHANGE.` Name what changed in one clause. | Yes |
| Answered | The comment is wrong or does not apply | `🤖 Harlan Agent Kit Agent: EVIDENCE. Not changed.` Lead with the proof in one or two sentences. | A bot's thread only |
| Follow-up | Everything else | Say where the work went. If an issue tracks it: `🤖 Harlan Agent Kit Agent: tracked in #NUMBER.` Otherwise: `🤖 Harlan Agent Kit Agent: not changed in this pull request: REASON.` Give the concrete reason in one clause. Never post a bare "optional follow-up, not changed". | A bot's thread only |

Push the fixing commit before the reply names it. Use the short SHA as the link text and the full SHA in the link.
Leave a human reviewer's thread open after Answered or Follow-up. That reviewer decides whether the answer is enough.
If a bot reviewer already marked its comment addressed and resolved the thread, it needs nothing more. CodeRabbit writes "✅ Addressed in commit".
A reply to CodeRabbit makes it answer. Post one reply per thread.

Reply on the thread. Just before you resolve it, run the list again. If a comment arrived after your reply, respond to it first.
Before replying or resolving, save the full root comment, including its body and `user.type`, in a scratch file.
For a verified private repository, use `HARLAN_AGENT_GITHUB_PRIVATE=OWNER/REPO gh` instead of `agent-gh` for this read.
Set `PR_SKILL_DIR` to the absolute directory of the installed `pr` Skill you read.
The [automatic resolution check](../scripts/can-resolve-thread.ts) reads that REST JSON and the response classification.
It refuses Service finding markers, empty bodies, and unknown response classifications.
Answered and Follow-up require `user.type` equal to `Bot`. Never infer bot identity from a login.
Post one reply before checking resolution permission. A human Answered or Follow-up still needs its reply.
Its nonzero exit leaves the thread open. Never bypass it after a read failure.
Set `RESPONSE` to `Fixed`, `Answered`, or `Follow-up`. Set `REPLY` to the matching reply from the table.
The `&&` runs each step only after the preceding step succeeds:

```bash
ROOT_COMMENT=~/scratch/review-thread-COMMENT_ID.json
agent-gh api repos/OWNER/REPO/pulls/comments/COMMENT_ID > "$ROOT_COMMENT" && \
gh api -X POST repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_ID/replies \
  -f body="$REPLY" && \
pnpm exec node --experimental-strip-types "$PR_SKILL_DIR/scripts/can-resolve-thread.ts" "$RESPONSE" < "$ROOT_COMMENT" && \
gh api graphql -X POST \
  -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' \
  -f id=THREAD_ID --jq .data.resolveReviewThread.thread.isResolved
```

`COMMENT_ID` is the first comment's `fullDatabaseId`. Preserve its complete decimal string in the REST path.
Do not convert it to a 32-bit integer or a JavaScript number.
`THREAD_ID` is the `PRRT_` ID. Both come from the list.
The resolve command prints `true` when GitHub resolved the thread.
If a read, reply, or resolve fails, leave the thread open and report the error.
A denied resolution check is expected for human Answered and Follow-up threads. Do not post another reply for that denial.
Never retry a failed command with other credentials or another tool.
This applies to every response that resolves a thread: Fixed, and Answered or Follow-up on a bot's thread.

Answer top-level items in one comment. Link each item it answers.

```bash
gh pr comment NUMBER --repo OWNER/REPO --body '🤖 Harlan Agent Kit Agent: ...'
```

## 4. Check the result

Run the list again. Each unresolved thread must be one of these:

- a Service finding that waits for Service verification, or a Logged finding with its Repair control available to Harlan
- a thread with an Agent reply from this sweep whose resolve failed and that the hand-back reports
- a human reviewer's thread that waits for that reviewer
- on a repository Harlan does not maintain, a thread whose drafted reply waits for Harlan

Each top-level item from another reviewer must have an Agent answer or a drafted answer.
Put the exact text of each draft in the hand-back. Report the counts there: Fixed, Answered, Follow-up, waiting, and drafted.
