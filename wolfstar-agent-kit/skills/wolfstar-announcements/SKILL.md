---
name: wolfstar-announcements
description: 'Write WolfStar announcements for any release or stage (alpha, beta, stable, hotfix) on Discord and the website. Use for release posts, stage changes, feature drops, breaking changes, downtime, or hotfix notices.'
user_invocable: true
argument-hint: '[repo or version] [discord | website]'
---

# WolfStar announcements

Write the community-facing post for a release, a stage change, a feature drop, a breaking change, downtime, or a hotfix. It works for any version and any project in the `wolfstar-project` organization: WolfStar, Staryl, Ring, stars-components, plugins.

The maintainer chats in Italian. The announcement itself is written in English unless he says otherwise.

For a full changelog or an upgrade guide, use [release-notes](../release-notes/SKILL.md). This Skill writes the short post that points at it.

## Surfaces

One announcement often needs two:

- **Discord**: a Components V2 message sent by webhook or bot. Payload rules and delivery limits: [discord-components-v2](references/discord-components-v2.md).
- **Website**: a post or notice on wolfstar.rocks or blog.wolfstar.rocks. Read the site's own conventions first: [website](references/website.md).

Ask which surface the maintainer wants. When he does not say, write the Discord message and offer the website version at the end.

## Gotchas

- **An open PR is never shipped.** Describe it under Coming soon, by effect, with no date.
- **GitHub GraphQL is blocked in some sessions.** `gh pr list` and `--search` fail there. Use `gh api "repos/wolfstar-project/<repo>/pulls?state=all&per_page=100&page=N"`.
- **A feature that depends on the web dashboard stays out** until the dashboard supports this version. "Logs live on the web" is wrong while the dashboard is behind.
- **Internal refactors stay out.** A framework, ORM, or CI change reaches the post only when users notice it.
- **Removed features go in.** List every removed command or feature, including one that only lost a listener.
- **The stage decides the warning.** An alpha warns about instability and data resets. A stable release or a hotfix carries no warning.
- **Never invent** a date, a screenshot, a quote, a figure, or a link. An unknown value is a placeholder, and the placeholder goes in the final summary.

## 1. Research once, reuse for every surface

1. Find what ships: the repository, the release branch or tag, and the umbrella pull request if there is one. Use `gh api repos/wolfstar-project/<repo>/releases`, `.../tags`, and `.../compare/<base>...<head>`.
2. Read the umbrella pull request body, then the body of every merged feature pull request. Its Breaking Changes and Migration sections feed Removed and the call to action.
3. Sort what you found into three buckets and keep them apart in the output:
   - **Shipped**: merged into the release branch or tag.
   - **Coming soon**: open pull requests.
   - **Removed or breaking**: dropped commands, renamed settings, migrations to run, a re-invite.
4. Read the umbrella pull request's Known issues so the post promises nothing that is broken.
5. Describe each feature by its effect for a server owner or a member, with command names in backticks.

When `gh api` answers "access not enabled", attach the repository with push access and retry.

## 2. Ask before drafting

Ask once, numbered, so the maintainer can reply by number. Ask only what the repository cannot answer:

1. Stage and audience: alpha, beta, stable, or hotfix. A separate bot or the production bot. The invite link.
2. Data: kept, reset, migrated, or importable later.
3. Which open pull requests go under Coming soon, and which stay out.
4. Whether removed features are listed. Default: yes.
5. Whether the web dashboard supports this version.
6. The feedback channel, and the channel for advance notice of changes.
7. The Discord format (plain text or Components V2) and the website surface (blog post, changelog entry, or banner).
8. Language and ping.

When nobody is there to answer, take the most reasonable default for each, say which defaults you took, and mark every unknown as a placeholder.

## 3. Content structure

Both surfaces use the same order. The website version is longer.

1. Title with the version or stage, then one sentence on what is live.
2. **What's new**, grouped by area, user-visible effect first.
3. **Coming soon**, from the open pull requests.
4. **Removed or breaking**, plus anything users must do.
5. **Stage warning**, only when the stage calls for one:
   - alpha: may be very unstable, commands and settings can change in breaking ways, data may be reset, changes are announced beforehand in the notices channel, do not rely on it for critical moderation;
   - beta: mostly stable, small breaking changes still possible;
   - stable or hotfix: no warning. Say what was fixed and whether anyone has to act.
6. Where to give feedback or report a bug.
7. A call to action: invite, update, or read the docs.

Check each line against the dashboard answer and the Known issues before it stays.

## 4. Finish

Run the prose through [humanize-writing](../humanize-writing/SKILL.md) before it goes out.

Close with a short summary:

- which surface or surfaces you produced;
- what you included, and what you left out on purpose, with the reason;
- the Discord character count when a Discord message exists;
- every placeholder still to replace.
