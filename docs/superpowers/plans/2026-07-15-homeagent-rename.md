# HomeAgent Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rename the product from Homebrain to HomeAgent across source, packages, macOS distribution, UI, and documentation without losing existing installations, settings, or backups.

**Architecture:** `HomeAgent` / `homeagent` / `HOMEAGENT_*` become the canonical display name, executable slug, and environment prefix. Compatibility is deliberately limited to persisted boundaries: legacy `HOMEBRAIN_*` variables remain readable, the old packaged data directory is copied after confirmation, the old LaunchAgent is removed during installation, and `homebrain.space` backups remain importable while new exports use `homeagent.space`.

**Tech Stack:** Bun workspaces, TypeScript, Hono, macOS LaunchAgent/Swift launcher, GitHub Actions

---

## File map

- `package.json`, `packages/*/package.json`, `tsconfig.base.json`, `bun.lock`: workspace and import identity.
- `packages/shared/src/config.ts`, `logger.ts`, `web-security.ts`: canonical environment variables with legacy fallbacks.
- `packages/app/src/runtime-paths.ts`, `data-migration.ts`, `service.ts`, `service-cli.ts`: renamed runtime paths and safe migration from the old application/service identity.
- `packages/core/src/governance.ts`: new backup format plus legacy import compatibility.
- `assets/macos/*`, `scripts/*`, `.github/workflows/release-macos.yml`: renamed app bundle, executable, DMG, bundle ID, URL scheme, and release artifacts.
- `packages/web/src/*`, connector/app messages, `README.md`, `THIRD_PARTY_NOTICES.md`, existing plans: product-facing terminology.

### Task 1: Rename the workspace identity

- [x] Change the root package name to `homeagent`, every workspace package to `@homeagent/*`, all workspace dependencies/imports, and TypeScript path aliases.
- [x] Regenerate `bun.lock` with `bun install --lockfile-only` and verify no `@homebrain/` imports remain.
- [x] Run `bunx tsc -p tsconfig.json --noEmit`; expect exit code 0.

### Task 2: Make `HOMEAGENT_*` canonical without breaking old source installs

- [x] Add environment lookup that prefers `HOMEAGENT_*` and falls back to the matching `HOMEBRAIN_*` value. For example:

```ts
function brandedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`HOMEAGENT_${name}`] ?? env[`HOMEBRAIN_${name}`];
}
```

- [x] Update config, logger, web security, provider executable overrides, runtime paths, service state, and doctor port lookup to use the canonical prefix.
- [x] Add tests proving the new variable wins when both forms exist and the old variable still works alone.
- [x] Run the focused shared/app/LLM test files; expect all tests to pass.

### Task 3: Migrate macOS data and service identity

- [x] Make bundled defaults resolve to `/Applications/HomeAgent.app`, `~/Library/Application Support/HomeAgent`, and `~/Library/Logs/HomeAgent`.
- [x] Prefer the previous packaged data source `~/Library/Application Support/Homebrain`, then the older source-install path `~/Applications/homebrain/data`, when the new destination is empty.
- [x] Keep the confirmation/copy/fsync/atomic-rename behavior and record the brand migration in `migration-v2.json` while leaving the source untouched.
- [x] Change the LaunchAgent label to `com.homeagent.agent` and plist path to `com.homeagent.agent.plist`; retain the internal `homebrain.lock` filename so old and new binaries coordinate on the same persisted lock.
- [x] After migration confirmation, unload and remove `com.homebrain.agent.plist` before copying data and bootstrapping the new service so the snapshot is quiescent and both Feishu consumers cannot run concurrently.
- [x] Add migration and service lifecycle tests, then run `bun test packages/app/src/data-migration.test.ts packages/app/src/service.test.ts packages/app/src/runtime-paths.test.ts`.

### Task 4: Preserve backup compatibility

- [x] Export new archives with `format: "homeagent.space"`.
- [x] Accept both `homeagent.space` and legacy `homebrain.space` in `parseSpaceArchive`, normalizing parsed output to `homeagent.space`.
- [x] Add a legacy-import test and update canonical export expectations.
- [x] Run `bun test packages/core/src/governance.test.ts packages/app/src/scheduler.test.ts`.

### Task 5: Rename macOS and release artifacts

- [x] Change the app to `HomeAgent.app`, executable/bundle entry to `homeagent`, bundle ID to `com.homeagent.desktop`, and URL scheme to `homeagent`.
- [x] Change DMGs to `HomeAgent-<version>-macos-<arch>.dmg`, build/smoke paths, codesign environment name, workflow artifacts, and updater tests.
- [x] Keep GitHub release repository selection dynamic through `${{ github.repository }}`; do not mutate the remote repository in this implementation.
- [x] Run all script tests and lint the generated plist/build plan.

### Task 6: Rename the product surface

- [x] Replace runtime log/error text, setup/admin HTML, Feishu registration source/name, default bot examples, CLI banners, README, notices, and plan references with `HomeAgent` or `homeagent` according to context.
- [x] Change repository URLs to `zhangga/homeagent` in release-facing docs/tests, relying on a later GitHub repository rename before release.
- [x] Retain `Homebrain`, `homebrain`, and `HOMEBRAIN_*` only in explicit compatibility code, compatibility tests, and migration documentation.
- [x] Search with `rg -n -i 'homebrain'` and review every remaining match.

### Task 7: Full verification

- [x] Run `bun install --frozen-lockfile`.
- [x] Run `bun test`; expect all tests to pass.
- [x] Run `bunx tsc -p tsconfig.json --noEmit`; expect exit code 0.
- [x] Review `git diff --check`, the final rename search, and `git status --short`.
- [x] Do not create commits or rename the GitHub repository in this session.
