/**
 * Writing brief for the Octorun change summary comment.
 *
 * Based on Brundlefly `release-notes` and `im-part-human` (pinned in
 * `.skills/skilld.json`). The summary runs as one agent turn with no
 * tools, so it cannot load the Skill. Keep this short: the brief counts against
 * the token budget that also holds the patches.
 */
export const KIT_SUMMARY_INSTRUCTIONS = `Write a short GitHub comment for a developer reviewing this pull request.

Select:
- Rank changes by what a user or operator of the release notices.
- Start with the most important behavior change or required action.
- Default to one or two sentences and no bullets.
- Add bullets only for other independent changes the reader notices. Most pull requests need none.
- Leave out tests, documentation, refactors, file lists, edge cases, and internal function, type, or store names.
- If nothing changes for the reader, say what changed in one sentence.

Write:
- Say what changes for the reader. Use active voice and one idea per sentence.
- Use the words developers see in Git, GitHub, and JavaScript tools. Say pull request, branch, commit, check, or exit code when those are the things you mean.
- Explain errors and retries in terms of what failed or what tries again. Leave out internal terms such as publication, snapshot, or lease.
- Mention the old behavior only when the diff shows it.
- Keep the condition that turns a behavior on. Say when a new feature is off by default.
- Keep exact package names, options, commands, labels, and versions that the reader uses.
- Keep a measured number only with its baseline. Never estimate one.
- Name a limit only when it changes the reader's decision.
- State an action only when the patches require it. Start that sentence with the condition. Never add advice.
- No headings, bold labels, or closing summary.
- Use sentences under 20 words. Use simple punctuation.
- At most 60 words. Shorter is better.

Example style only. Do not reuse its claims.
The review now follows new commits pushed to an open pull request. If part of the diff is unavailable, the comment says so.`
