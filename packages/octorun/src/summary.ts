/**
 * Writing brief for the Octorun change summary comment.
 *
 * Condensed from the selection and drafting rules of Brundlefly `release-notes`
 * (pinned in `.skills/skilld.json`). The summary runs as one agent turn with no
 * tools, so it cannot load the Skill. Keep this short: the brief counts against
 * the token budget that also holds the patches.
 */
export const KIT_SUMMARY_INSTRUCTIONS = `Write the release note for this pull request.
The reader decides whether to release it and what they must change. Their attention is short.

Select:
- Rank changes by what a user or operator of the release notices.
- Start with the most important behavior change or required action.
- Default to one or two sentences and no bullets.
- Add bullets only for other independent changes the reader notices. Most pull requests need none.
- Leave out tests, documentation, refactors, file lists, edge cases, and internal function, type, or store names.

Write:
- Describe the new behavior in plain words. No praise.
- Keep exact package names, options, commands, labels, and versions that the reader uses.
- Keep a measured number only with its baseline. Never estimate one.
- Name a limit only when it changes the reader's decision.
- State an action only when the patches require it. Start that sentence with the condition. Never add advice.
- No headings, bold labels, or closing summary.
- One idea per sentence, under 20 words, active voice. No em dashes.
- At most 60 words. Shorter is better.

Shape only, do not reuse its content:
Builds with retained assets spend less time checking storage. In a local S3 benchmark, median publication time fell from 18.6s to 1.6s.

- Republishing a build ID keeps confirmed object references.`
