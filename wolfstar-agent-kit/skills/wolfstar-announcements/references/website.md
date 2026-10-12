# Website announcements

The WolfStar site is a Nuxt 4 and Vue 3 app in `wolfstar-project/wolfstar.rocks`. The blog is its own repository, `wolfstar-project/blog.wolfstar.rocks`. Translations run through Tolgee. Read the conventions below from the repositories before writing, because they change.

## Find the conventions

1. Read `AGENTS.md` in both repositories. Read `COPY.md` and `GLOSSARY.md` too, where they exist.
2. Open the most recent published post or changelog entry. Copy its structure, its frontmatter fields, its slug style, and its date format.
3. Settle the surface with the maintainer when it is not obvious:
   - **Blog post**: the long version, self-contained.
   - **Changelog entry**: the shipped, coming soon, and removed lists, with little prose.
   - **Banner or notice**: one or two lines and a link.

## Write it

1. Reuse the research and the three buckets from the Skill: shipped, coming soon, removed or breaking.
2. Write a plain title, a one-sentence meta description, and an opening paragraph that says what is live and who it affects. Then add the sections from the content structure in the Skill.
3. Put in a screenshot only when the maintainer supplies one. Never invent an image, a quote, or a date.
4. Run the prose through [humanize-writing](../../humanize-writing/SKILL.md). Check user-visible strings against [copywriting](../../copywriting/SKILL.md) and the repository's `COPY.md`, and terms against its `GLOSSARY.md`.
5. When a string goes through Tolgee, add the English key only and say that the other languages sync later. Never hand-edit a generated locale file.

## Deliver

- Change the repository through a pull request with the [pr](../../pr/SKILL.md) Skill. Never push to `main`.
- When no write access is attached, hand over the file contents and the target path.
- GitHub issues and pull request text are written in English.
- Link both ways when both surfaces exist: the Discord button row points at the post, and the post points at the invite or the docs.
