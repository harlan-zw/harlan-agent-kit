# pnpm Workspace Catalogs

Use default `catalog:` (not named catalogs). All deps in a single flat catalog.

## Single repo - pnpm-workspace.yaml

```yaml
shellEmulator: true
trustPolicy: no-downgrade

catalog:
  '@antfu/eslint-config': ^7.2.0
  '@arethetypeswrong/cli': ^0.18.2
  '@types/node': ^25.2.1
  bumpp: ^10.4.1
  eslint: ^9.39.2
  eslint-plugin-harlanzw: ^0.2.0
  lint-staged: ^16.3.2
  obuild: ^0.4.24
  typescript: ^6.0.0
  vitest: ^4.0.18

ignoredBuiltDependencies:
  - esbuild
```

## Monorepo - pnpm-workspace.yaml

```yaml
packages:
  - playground
  - packages/*

shellEmulator: true
trustPolicy: no-downgrade

catalog:
  '@antfu/eslint-config': ^7.2.0
  '@arethetypeswrong/cli': ^0.18.2
  '@types/node': ^25.2.1
  bumpp: ^10.4.1
  eslint: ^9.39.2
  eslint-plugin-harlanzw: ^0.2.0
  lint-staged: ^16.3.2
  obuild: ^0.4.24
  typescript: ^6.0.0
  vitest: ^4.0.18
  # add runtime deps shared across packages here

ignoredBuiltDependencies:
  - esbuild
```

## Usage in package.json

```json
{
  "devDependencies": {
    "eslint": "catalog:",
    "eslint-plugin-harlanzw": "catalog:",
    "@antfu/eslint-config": "catalog:",
    "vitest": "catalog:",
    "typescript": "catalog:",
    "obuild": "catalog:"
  },
  "dependencies": {
    "defu": "catalog:"
  }
}
```

## Migration

1. Replace `catalogs:` (named) with flat `catalog:` if present
2. Move all version entries under single `catalog:` key
3. Replace versions in package.json with `catalog:`
4. Replace `onlyBuiltDependencies` with `ignoredBuiltDependencies`
5. Add `shellEmulator: true` and `trustPolicy: no-downgrade`
6. Remove `catalogMode: prefer` if present
7. Run `pnpm install` to verify
