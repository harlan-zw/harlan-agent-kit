# Token Regression Checks

The YAML front matter in `DESIGN.md` is the machine-readable source of truth for colors, typography, spacing, radii, and component surfaces.

## Drift (git-diff based)

```bash
HASH=$(jq -r '.git_hash // empty' {JOB_DIR}/build-handoff.json)
git diff "$HASH" -- DESIGN.md | sed -n '/^---$/,/^---$/p'
```

- `design_system_changes == false` in the handoff: any front matter diff is drift. Flag **TOKEN DRIFT** (hard reject).
- `design_system_changes == true`: the diff is expected. Verify it matches the contract's stated design intent.

## Structural + contrast lint (preferred)

```bash
npx --yes @google/design.md lint DESIGN.md 2>/dev/null
```

Parse the JSON. Hard rejects:
- any `severity: "error"` (broken refs, invalid hex, section-order violations)
- contrast-ratio warnings on `components.*` pairs below 4.5:1, unless `## Design Decisions` explicitly accepts that pairing (e.g. "button-primary contrast 3.96:1 accepted: large text only, signature purple is theme-defining")

Informational, not rejects: unknown component property warnings (`shadow`, `border`, `boxShadow`, `transform`), and orphaned-token warnings on palette colors that exist for theming without a specific component reference.

## Fallback

Some theme front matter uses `rgba()` or float alpha values that crash the alpha linter (`raw.match is not a function`). If the CLI exits nonzero without valid JSON:

```bash
grep -oE '\{(colors|rounded|spacing|typography)\.[a-z-]+\}' DESIGN.md
```

Verify every match resolves to a key in the front matter.

If front matter is absent entirely, note it and skip. The project predates the token schema.
