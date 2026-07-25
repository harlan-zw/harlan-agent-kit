# Mechanical Checks

Run all of these on the changed files. Report each result, even when clean.

## Class-token inventory (preferred over grep for design-system compliance)

AST-aware tokenization across `.vue`/`.ts`/`.tsx` (strings, class attrs, `@apply`). Catches Vue template class bindings and kebab-case component tags that grep misses.

```bash
npx -y @ripast/cli css-class-scan --glob 'app/**' --sort count-desc --json \
  | jq '[.tokens[] | select(.token | test("^(slate|gray|zinc|stone|bg-white|text-black|border-gray)"))]'

npx -y @ripast/cli css-class-scan --pattern 'font-inter,font-roboto,font-arial,font-system-ui' --glob 'app/**' --json
```

Cross-reference `slate-/gray-/zinc-/stone-` hits against the project's configured neutral in `app.config.ts`; exclude that neutral.

## Dead code (catches generator-left scaffolding)

```bash
npx -y @ripast/cli unused --tsconfig .nuxt/tsconfig.json --exports local --json
```

Any hit in a file the generator created or modified is a RUBRIC violation.

## Remaining greps (no AST equivalent)

```bash
# Completeness
grep -rEn 'TODO|FIXME|placeholder|Lorem|Coming soon|Sample' {changed_files}

# Raw color values
grep -rEn '#[0-9a-fA-F]{3,8}' {changed_files}
grep -rEn 'rgb|hsl|rgba' {changed_files}

# Custom tokens that should have been Nuxt UI overrides
grep -rEn '^\s*--[a-z]' app/assets/css/main.css | grep -v '\-\-ui-' | grep -v '\-\-font-' | grep -v '\-\-color-'
```

Every custom token found needs justification. Flag any that duplicates a `--ui-*` variable or a Tailwind utility.

## Component locality (single-caller global components)

Every component in `app/components/` touched by the diff needs ≥2 unrelated callers, otherwise it should be colocated as `_Component.vue` next to its sole consumer.

```bash
npx -y @ripast/cli scan <ComponentName> --kind jsx,identifier-reference --tsconfig .nuxt/tsconfig.json --json
```

Single caller in a single feature dir is a RUBRIC violation: "global auto-import without cross-feature consumers."
