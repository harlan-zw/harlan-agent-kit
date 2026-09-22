---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Draft the pull request description for this change. Do not push anything and do
not open anything, I just want the description text.

The change fixes a token refresh bug: `token_expires_at` could be null, and the
sync processor skipped the refresh when it was, so those sites silently stopped
syncing. I added a migration to backfill the column, a guard in the processor,
and eleven unit tests plus two end-to-end cases covering the null path.
