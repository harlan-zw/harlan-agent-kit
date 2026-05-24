# Changelog Category Mapping

## Conventional Commit → Changelog Section

| Prefix | Section | Emoji | Include in Changelog |
|--------|---------|-------|---------------------|
| `feat:` | Enhancements | 🚀 | Always |
| `feat!:` | Enhancements + Breaking | 🚀 + ⚠️ | Always |
| `fix:` | Fixes | 🩹 | Always |
| `fix!:` | Fixes + Breaking | 🩹 + ⚠️ | Always |
| `perf:` | Performance | 🔥 | Always |
| `refactor:` | Refactors | 💅 | If significant |
| `docs:` | Documentation | 📖 | If user-facing |
| `build:` | Build | 📦 | If significant |
| `chore:` | Chore | 🏡 | If significant |
| `test:` | Tests | ✅ | Optional |
| `ci:` | CI | 🤖 | Optional |
| `style:` | (omit) | | Rarely include |

## Breaking Change Detection

A commit is breaking if ANY of these are true:
1. Type has `!` suffix: `feat!:`, `fix!:`, `refactor!:`
2. Commit body contains `BREAKING CHANGE:` (case-sensitive per spec)
3. PR has a `breaking` or `breaking-change` label

## Scope Extraction

Scopes in parentheses map to subsections or tags:
- `feat(router):` → listed under Enhancements, tagged with `router`
- `fix(ssr):` → listed under Fixes, tagged with `ssr`

Use scopes to group related changes when a single scope has 3+ entries.

## Filtering Rules

- Merge commits (`Merge branch`, `Merge pull request`) → exclude
- Revert commits → include with note about what was reverted
- Release commits (`chore: release`, `chore: bump`) → exclude
- Dependency bumps (`chore(deps):`) → collapse into single line unless security-related
