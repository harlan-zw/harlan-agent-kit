# Review queue capacity

Use the [service control command](../../harlan-github-agent/SKILL.md#run-and-inspect) to read `harlan-github-agent control status`.
Run it on the Service host. On Hogwild, use the config path and loopback URL below.
If that host lacks the control CLI, read its authenticated `/api/state` endpoint instead.
The endpoint returns the same `state` object. Do not treat a failed command as an empty Queue.
Match this repository, pull request number, and current head SHA in `state.queue` when present.
Check the targeted Item endpoint's `dismissed` field first. A dismissed Item stops all Review work, even after a new head.
The dashboard snapshot lists only 100 recent Items, so absence from `state.items` proves nothing.
If the targeted Item request fails, report the missing Service state. Do not start a fallback review.
Use the Control API's configured Basic authentication for both requests. Never print the password.
If the matching Queue entry is missing, use a queued Review Task for this pull request as the capacity signal.
Refetch the GitHub head before spawning; the Task alone does not identify its head SHA.
Count `state.tasks` whose state is `Queued` and kind is `adversarial_review` or `review_fix`.
Calculate free host slots from `state.hostCapacity`: local maximum minus active, plus desktop maximum minus active when connected.

```bash
harlan-github-agent control status \
  --config /home/harlan/.config/harlan-github-agent/config.yml \
  --url http://127.0.0.1:3210 |
  jq --arg repo OWNER/REPO --argjson number NUMBER --arg head HEAD_SHA '
    (.state // .) as $state |
    {agentStart: $state.agentStart._tag,
     hostCapacity: $state.hostCapacity,
     queuedWork: [$state.tasks[] | select(.state._tag == "Queued") |
       select(.kind == "adversarial_review" or .kind == "review_fix")],
     targetTask: [$state.tasks[] | select(.kind == "adversarial_review" and
       .repository == $repo and .pullRequestNumber == $number and
       .state._tag == "Queued")][0],
     target: [$state.queue[] | select(.kind == "pull_request" and
       .repository == $repo and .number == $number and .headSha == $head)][0]}'
```

Start a subagent review when Review is queued for this pull request and either condition holds:

- At least two Review or Repair Tasks are queued, and their count exceeds free host slots.
- `state.agentStart._tag` is `ReserveReached` or `CapacityUnavailable`.

Also start one 20 minutes after the recorded Review request if Review remains queued or no Task appears.
This also applies when the control CLI is unavailable, the authenticated API works, and no trusted `REVIEWING` comment exists.
Never start a subagent while the Service Review Task is `Running` or `Publishing`.
If an active Review stalls, report its Service Incident or exact Task state.
Require an open pull request, a recorded request, and targeted Item status with `dismissed: false`.
Exclude an intentional pause, stop, cancellation, or missing Approval.
Record the capacity snapshot or elapsed time that triggered the decision.
Do not infer saturation from `maxOpenPullRequests`; that limit controls new Issue work.

Before spawning, stop the Service Review for this exact head:

```bash
harlan-github-agent control stop-review \
  --repository OWNER/REPO --number NUMBER --head HEAD_SHA \
  --config /home/harlan/.config/harlan-github-agent/config.yml \
  --url http://127.0.0.1:3210
```

Run the command on the Service host. `Stopped` and `AlreadyStopped` permit the subagent.
The command checks the current open head, records a durable stop for that head, and cancels its queued Review Task.
It rejects a dismissed Item, changed head, or Review that already started.
If the command fails, report the exact error and leave the Service Review in charge.
Refetch the GitHub head after the command. If it moved, stop and restart Step 6.
Spawn one native subagent for this exact head SHA.
Give it the pull request snapshot and disproof checks in the [review contract](../../adversarial-review/references/review-contract.md#adversarial-review).
It reads the full diff, surrounding code, author images, and current checks.
Keep it read only. It returns evidence-backed findings with impact from 0 to 100, path, line, and proof.
Give every finding a proposed next action. Include lower scores as Logged optional follow-ups.
It does not post comments, set labels, approve, or merge.
The Service Review is stopped for this head. A new head needs a new Review request.
Refetch the head before acting on findings. Discard the subagent assessment if the head moved.
Refetch targeted Item status before posting an assessment. Stop if it became dismissed.

Apply confirmed findings above 80 in new commits, subject to the three-push limit, then restart Step 6 for the new head.
Mark false positives or inapplicable findings in one self-identified Agent comment with evidence.
If no confirmed blocker remains, post a self-identified Agent assessment with the head SHA and capacity reason.
Start that comment with `🤖 Harlan Agent Kit Agent assessment of head SHA.`
After CI passes, report the subagent's result and the stopped Service Review.
Never call the subagent assessment `READY` or change the service's marked status.

