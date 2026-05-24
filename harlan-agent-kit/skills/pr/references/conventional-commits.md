# Conventional Commits Reference

## Format

```
type(scope): description
```

## Types

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `chore` | Maintenance, deps, CI config |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding or fixing tests |
| `style` | Formatting, whitespace (not CSS) |

## Scope

Optional, in parentheses. Use the module/area name: `feat(auth):`, `fix(api):`, `chore(deps):`.

## Rules

- Title under 70 chars
- Imperative mood ("add" not "added" or "adds")
- No period at end
- Body explains **why**, not what (the diff shows what)
- `BREAKING CHANGE:` footer or `!` after type for breaking changes: `feat!: remove v1 API`
