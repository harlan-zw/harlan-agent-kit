# Comment voice

Agents write the words that the Service and the `pr` Skill publish on GitHub.
Templates own the layout. This contract owns the words.

| Surface | Apply |
| --- | --- |
| Review findings, Review run fields, review thread replies, verification comments, other Agent comments, Issue triage text | This whole contract |
| Pull request descriptions | [Never publish](#never-publish) only. The Brundlefly `pull-request-summary` Skill owns the rest. |
| Routine reports and Candidates, which become issue comments and issues | [Never publish](#never-publish) only. The Routine Skill owns the rest. |

## Say only what GitHub cannot show

- In prose, never restate check run results, mergeable state, or approving reviews.
  The merge box shows them before a reader reaches the comment.
- Name a gate only when it is the sole reason for BLOCKED. Use two or three words.
- A failing check run or a merge conflict can still be a Review finding. Then write it as a finding.
- Never describe your process, such as "I reviewed", "I ran", or "Let me". State the result.

## Review run

Return two fields with every Review run. If the controller's response schema omits them, follow the schema.

- `checked` (string): one clause that names what the Review exercised. Name inputs, cases, or files.
  Example: "Timeline reads against overlapping, dense, and daylight saving windows".
- `notChecked` (string or null): one clause that names the largest gap.
  Example: "the dashboard in a browser". Return null only when the Review skipped nothing.

Never write "looks good" or "LGTM". The score is a number. These clauses say what it rests on.

## Finding

Each Review finding carries `summary`, `proof`, and `nextAction`.

- **Title (`summary`):** the consequence, in 10 words or fewer, in the present tense.
  Write "Draft saves skip approval when HOME is unset", not "Potential issue with HOME handling".
  A reader decides from the title alone whether to open the finding.
- **Proof (`proof`):** the condition, then the effect, in one to three sentences.
  Name the input that triggers it. Do not hedge with "might" or "could" unless you state the condition.
- **Next action (`nextAction`):** one imperative sentence. Start with the verb.
  Never start it with "Optional follow-up" or "As an optional follow-up". The template labels a Logged finding.

Never return a `scope` field. Only the controller sets it.

## Thread replies

The `pr` Skill's [review threads](../skills/pr/references/review-threads.md) Reference owns when to reply and when to resolve.
This section owns the words. Each reply starts with `🤖 Harlan Agent Kit Agent:` and gives one response.

- **Fixed:** `fixed in [abc1234](URL): <what changed, in one clause>.`
- **Answered:** the evidence first, in one or two sentences, then `Not changed.`
- **Follow-up:** say where the work went. Use a fact you can check when you reply:
  - `tracked in #123.` when that issue exists.
  - `Repair fixes this in this pull request.` only on a Service finding thread whose Repair is still active.
  - `not changed in this pull request: <reason, in one clause>.` when the work goes nowhere.
    Name the concrete reason, such as the cost or the missing evidence.

Never post a bare "optional follow-up, not changed".
Never open with thanks, praise, or an apology. Never concede without the fact that changed the conclusion.

## Issue triage

- Write `summary` to the person who opened the issue, in two sentences or fewer.
- Write `nextAction` to the agent or person who acts next.
- For Needs info, return `ask` when the response schema has it. Put each missing fact in its own entry, as a noun phrase.

## Never publish

A GitHub reader cannot open anything on your machine.
Test each path, host, error, and ID: does it describe the code under review, or your own run? Publish only the first.

Never publish:

- Paths and hosts from your own run: your worktree root, your home directory, `~/scratch`, `~/notes`, and `notes.localhost` links.
  Write repository paths relative to the repository root.
- Raw provider or tool errors from your run. Map each one to a cause a maintainer can act on.
  Write "The npm registry refused the read", not the stack trace.
- Tokens, session IDs, and UUIDs with no label that says what they name.

You may publish:

- `localhost` URLs and paths such as `~/.config/<tool>` when they describe the code under review.
  Example: a `curl` against the local preview in a Candidate's verification.
- Diagnostics copied from a check run log, when they are the evidence.
- Labelled IDs that a reader can look up, such as a Site ID, an action ID, or a Sentry issue ID.

Your chat conventions never apply to published text.
A notes file, a `notes.localhost` link, and `~/scratch` evidence belong in chat, never on GitHub.

## Style

- Outcome first. One idea per sentence, under 20 words.
- Put the condition before the command. Use the active voice.
- Use sentence case. In prose, put scores and SHAs in code spans.
- No em dashes. No "it's not X, it's Y".
