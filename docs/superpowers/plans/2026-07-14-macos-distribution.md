# Self-Contained macOS Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed Homebrain macOS application that a normal user downloads, drags to Applications, launches, signs into ChatGPT and Feishu in the browser, and leaves running without installing Git, Bun, Node, npm, or `lark-cli`.

**Architecture:** Compile a small native Swift launcher, bundle the JavaScript application plus an unmodified architecture-matched Bun executable as separate immutable resources, and place verified third-party CLIs inside `Homebrain.app/Contents/Resources`. Store mutable data under `~/Library/Application Support/Homebrain`, and point LaunchAgent at the stable native app launcher. Build architecture-specific release artifacts in CI, sign/notarize them, and expose a guarded in-app updater that stages and verifies a replacement before restart.

**Tech Stack:** Native Swift launcher, separately bundled Bun runtime and JavaScript application, macOS `.app`/DMG, LaunchAgent, GitHub Actions, Apple codesign/notarytool, bundled `lark-cli`, consent-based official Codex download, Bun test.

---

## Release contract

- Primary artifact: `Homebrain-<version>-macos-<arm64|x64>.dmg`.
- First launch opens `http://127.0.0.1:<port>/setup` automatically.
- No repository checkout or global package install is required.
- Default data root: `~/Library/Application Support/Homebrain`.
- Logs: `~/Library/Logs/Homebrain`.
- LaunchAgent: `~/Library/LaunchAgents/com.homebrain.agent.plist` pointing inside `/Applications/Homebrain.app`.
- Bundled `lark-cli` is the only Feishu executable used by production. PATH fallback remains for source development.
- Do not redistribute Codex in the first release. The setup screen installs an official Codex standalone release into `~/Library/Application Support/Homebrain/bin` only after explicit user consent and checksum verification.
- Claude and TRAE remain optional externally managed providers.

## File structure

- Create `packages/app/src/runtime-paths.ts`: source-versus-bundle path resolution.
- Create `packages/app/src/desktop.ts`: foreground launcher that starts/locates the service and opens setup.
- Create `packages/app/src/doctor.ts`: machine-readable installation diagnostics.
- Create `scripts/build-macos-app.ts`: deterministic app-bundle assembly.
- Create `scripts/write-update-manifest.ts`: SHA-256 release manifest generation.
- Create `scripts/smoke-macos-bundle.ts`: isolated launch and probe.
- Create `.github/workflows/release-macos.yml`: build, test, sign, notarize and publish.
- Modify `packages/connectors/src/feishu.ts` and `packages/connectors/src/lark-setup.ts`: accept the bundled Lark binary.
- Modify `packages/llm/src/providers.ts`: accept per-provider binary overrides.
- Modify `packages/app/src/service.ts`: stable app-bundle ProgramArguments and Library data/log locations.
- Modify `packages/orchestrator/src/attachment-extractor.ts`: execute a precompiled, signed extraction helper in bundled mode.
- Modify root `package.json`, `.gitignore`, and `bun.lock`: reproducible release commands.

### Task 1: Establish reproducible release metadata

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Add: `bun.lock`
- Add: `LICENSE`
- Add: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Stop ignoring the lockfile**

Remove `bun.lock` from `.gitignore`, regenerate with the repository's pinned Bun version, and verify:

```bash
bun install --frozen-lockfile
git status --short bun.lock
```

Expected: `bun.lock` is tracked and frozen install succeeds.

- [ ] **Step 2: Set an actual beta version and release scripts**

Update root `package.json`:

```json
{
  "name": "homebrain",
  "version": "0.1.0-beta.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "bun run packages/app/src/main.ts",
    "service": "bun run packages/app/src/service-cli.ts",
    "doctor": "bun run packages/app/src/doctor.ts",
    "build:macos": "bun run scripts/build-macos-app.ts",
    "smoke:macos": "bun run scripts/smoke-macos-bundle.ts"
  }
}
```

Preserve the existing `workspaces` and `devDependencies` fields unchanged.

- [ ] **Step 3: Add the Apache-2.0 project license and third-party notices**

Add the unmodified Apache License 2.0 text as `LICENSE`. Record Bun, Hono, `lark-cli`, and every redistributed binary license in `THIRD_PARTY_NOTICES.md`; link the downloaded-but-not-redistributed Codex license separately. Do not publish a binary until every redistributed artifact has a license entry and source URL.

- [ ] **Step 4: Verify and commit**

```bash
bun install --frozen-lockfile
bun test
git add package.json .gitignore bun.lock LICENSE THIRD_PARTY_NOTICES.md
git commit -m "build: make Homebrain releases reproducible"
```

### Task 2: Resolve runtime paths independently of the repository

**Files:**
- Create: `packages/app/src/runtime-paths.ts`
- Create: `packages/app/src/runtime-paths.test.ts`
- Modify: `packages/connectors/src/feishu.ts`
- Modify: `packages/connectors/src/lark-setup.ts`
- Modify: `packages/orchestrator/src/attachment-extractor.ts`
- Modify: `packages/llm/src/providers.ts`

- [ ] **Step 1: Write failing bundled-path tests**

Create tests that pass `/Applications/Homebrain.app/Contents/MacOS/homebrain` and assert:

```ts
expect(paths.dataDir).toBe(join(home, "Library", "Application Support", "Homebrain"));
expect(paths.logDir).toBe(join(home, "Library", "Logs", "Homebrain"));
expect(paths.larkBin).toBe("/Applications/Homebrain.app/Contents/Resources/bin/lark-cli");
expect(paths.attachmentHelper).toBe("/Applications/Homebrain.app/Contents/Resources/bin/attachment-extract");
```

- [ ] **Step 2: Run the test and verify failure**

```bash
bun test packages/app/src/runtime-paths.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement deterministic path resolution**

Create `runtime-paths.ts` with:

```ts
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RuntimePaths {
  bundled: boolean;
  appRoot: string;
  resourceDir: string;
  dataDir: string;
  logDir: string;
  larkBin: string;
  attachmentHelper?: string;
}

export function resolveRuntimePaths(input: {
  execPath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
} = {}): RuntimePaths {
  const execPath = input.execPath ?? process.execPath;
  const home = input.homeDir ?? homedir();
  const env = input.env ?? process.env;
  const marker = ".app/Contents/MacOS/";
  const markerAt = execPath.indexOf(marker);
  const bundled = markerAt >= 0;
  const appRoot = bundled ? execPath.slice(0, markerAt + 4) : resolve(input.repoRoot ?? join(import.meta.dir, "../../.."));
  const resourceDir = bundled ? join(appRoot, "Contents", "Resources") : join(appRoot, "packages", "orchestrator", "src");
  const dataDir = resolve(env.HOMEBRAIN_DATA_DIR ?? (bundled
    ? join(home, "Library", "Application Support", "Homebrain")
    : join(appRoot, "data")));
  return {
    bundled,
    appRoot,
    resourceDir,
    dataDir,
    logDir: bundled ? join(home, "Library", "Logs", "Homebrain") : join(dataDir, "logs"),
    larkBin: env.HOMEBRAIN_LARK_BIN ?? (bundled ? join(resourceDir, "bin", "lark-cli") : "lark-cli"),
    attachmentHelper: bundled ? join(resourceDir, "bin", "attachment-extract") : undefined,
  };
}
```

- [ ] **Step 4: Inject binary paths and remove the end-user Swift compiler dependency**

Add `larkBin` constructor options where already supported and pass `resolveRuntimePaths().larkBin` from `main.ts`. Add `HOMEBRAIN_CODEX_BIN`, `HOMEBRAIN_CLAUDE_BIN`, and `HOMEBRAIN_TRAE_BIN` overrides to provider specs instead of hard-coding command names. In bundled mode, execute `attachmentHelper` directly; retain the current temporary Swift compilation only for source-development mode. Reject a helper path outside `Homebrain.app/Contents/Resources/bin` when bundled.

- [ ] **Step 5: Run tests and commit**

```bash
bun test packages/app/src/runtime-paths.test.ts packages/connectors/src/lark-setup.test.ts packages/connectors/src/feishu.test.ts packages/llm/src/providers.test.ts packages/orchestrator/src/attachment-extractor.test.ts
git add packages/app/src/runtime-paths.ts packages/app/src/runtime-paths.test.ts packages/connectors/src/feishu.ts packages/connectors/src/lark-setup.ts packages/orchestrator/src/attachment-extractor.ts packages/llm/src/providers.ts
git commit -m "refactor: resolve bundled Homebrain runtime paths"
```

### Task 3: Assemble a self-contained `Homebrain.app`

**Files:**
- Create: `scripts/build-macos-app.ts`
- Create: `scripts/build-macos-app.test.ts`
- Create: `assets/macos/Info.plist.template`
- Add: `assets/macos/AppIcon.icns`

- [ ] **Step 1: Write manifest and layout tests**

Assert that a dry-run build plan contains:

```text
Homebrain.app/Contents/Info.plist
Homebrain.app/Contents/MacOS/homebrain
Homebrain.app/Contents/Resources/app/homebrain.js
Homebrain.app/Contents/Resources/bin/bun
Homebrain.app/Contents/Resources/bin/lark-cli
Homebrain.app/Contents/Resources/bin/attachment-extract
Homebrain.app/Contents/Resources/THIRD_PARTY_NOTICES.md
```

- [ ] **Step 2: Run the test and verify failure**

```bash
bun test scripts/build-macos-app.test.ts
```

Expected: missing build module.

- [ ] **Step 3: Implement app assembly**

The build script must:

1. Refuse a dirty lockfile or unsupported target.
2. Compile the native launcher, then run `bun build --target=bun packages/app/src/main.ts` into `Contents/Resources/app/homebrain.js` and copy the matching official Bun executable to `Contents/Resources/bin/bun`.
3. Compile `packages/orchestrator/src/attachment-extract.swift` once for the target architecture, link Vision/PDFKit, and place the helper at `Contents/Resources/bin/attachment-extract`.
4. Download the exact `lark-cli` release for the target architecture from GitHub Releases.
5. Download its published checksum file over HTTPS and verify SHA-256 before extraction.
6. Write `Info.plist` with bundle id `com.homebrain.desktop`, semantic version from `package.json`, minimum macOS 13, and URL scheme `homebrain`.
7. Set both executables to `0755`, resources to `0644`, and sign the extraction helper before signing the outer app.
8. Emit `dist/Homebrain.app` and no mutable data inside it.

- [ ] **Step 4: Build locally and inspect**

```bash
bun run build:macos --target "$(uname -m)"
plutil -lint dist/Homebrain.app/Contents/Info.plist
codesign --verify --deep --strict dist/Homebrain.app || true
```

Expected: build and plist lint pass; unsigned local builds may fail codesign verification until Task 7.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-macos-app.ts scripts/build-macos-app.test.ts assets/macos
git commit -m "build: assemble standalone Homebrain macOS app"
```

### Task 4: Make first launch install and open the managed service

**Files:**
- Create: `packages/app/src/desktop.ts`
- Create: `packages/app/src/desktop.test.ts`
- Modify: `packages/app/src/service.ts`
- Modify: `packages/app/src/service.test.ts`
- Modify: `packages/app/src/service-cli.ts`

- [ ] **Step 1: Write failing desktop-launch tests**

Cover these outcomes:

```ts
expect(await launchDesktop({ service: stopped, open, waitForHealth })).toEqual({ action: "installed-and-opened" });
expect(open).toHaveBeenCalledWith("http://127.0.0.1:3000/setup");
```

Also assert an already-running service is not reinstalled and an unavailable port produces a visible macOS alert instead of a silent exit.

- [ ] **Step 2: Implement desktop launch**

`desktop.ts` must install/start the LaunchAgent, poll `/healthz` for up to 20 seconds, then invoke `/usr/bin/open http://127.0.0.1:<port>/setup`. Use `/usr/bin/osascript` only for a bounded error dialog when launch fails.

- [ ] **Step 3: Point LaunchAgent at the bundle**

When bundled, plist ProgramArguments must be:

```xml
<array>
  <string>/Applications/Homebrain.app/Contents/MacOS/homebrain</string>
  <string>serve</string>
</array>
```

Do not include the repository working directory. Write logs to `~/Library/Logs/Homebrain` and data to `~/Library/Application Support/Homebrain`.

- [ ] **Step 4: Add CLI dispatch to the compiled entrypoint**

Support `serve`, `desktop`, `service <command>` and `doctor --json` from one binary. Source scripts continue to delegate to the same exported functions.

- [ ] **Step 5: Run and commit**

```bash
bun test packages/app/src/desktop.test.ts packages/app/src/service.test.ts packages/app/src/service-cli.test.ts
git add packages/app/src/desktop.ts packages/app/src/desktop.test.ts packages/app/src/service.ts packages/app/src/service.test.ts packages/app/src/service-cli.ts
git commit -m "feat: launch Homebrain as a macOS desktop service"
```

### Task 5: Add a user-facing installation doctor and data migration

**Files:**
- Create: `packages/app/src/doctor.ts`
- Create: `packages/app/src/doctor.test.ts`
- Create: `packages/app/src/data-migration.ts`
- Create: `packages/app/src/data-migration.test.ts`

- [ ] **Step 1: Write failing diagnostics tests**

The JSON result must have stable checks:

```ts
expect(report.checks.map((check) => check.id)).toEqual([
  "macos", "data-directory", "lark-cli", "ai-provider", "port", "launch-agent", "feishu-runtime",
]);
```

- [ ] **Step 2: Implement bounded diagnostics**

Each check returns `pass`, `action`, or `fail`, a human sentence and a setup URL. Never include environment values, tokens or raw child-process output.

- [ ] **Step 3: Migrate source-install data safely**

On first bundled launch, if the new data directory is empty and the old `~/Applications/homebrain/data` exists, show a browser confirmation. After confirmation, copy to a sibling staging directory, fsync, atomically rename, and leave the source untouched. Record `migration-v1.json` with source, destination, time and result.

- [ ] **Step 4: Run and commit**

```bash
bun test packages/app/src/doctor.test.ts packages/app/src/data-migration.test.ts
git add packages/app/src/doctor.ts packages/app/src/doctor.test.ts packages/app/src/data-migration.ts packages/app/src/data-migration.test.ts
git commit -m "feat: diagnose and migrate Homebrain installations"
```

### Task 6: Provide a zero-terminal AI provider path

**Files:**
- Create: `packages/llm/src/provider-setup.ts`
- Create: `packages/llm/src/provider-setup.test.ts`
- Modify: `packages/llm/src/providers.ts`
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/app.ts`

- [ ] **Step 1: Install Codex from the official release after user consent**

Do not place Codex inside `Homebrain.app`. On the explicit `连接 ChatGPT` action, download the official architecture-specific Codex executable, verify the release checksum over HTTPS, record the installed version and source URL, then atomically install it to `~/Library/Application Support/Homebrain/bin/codex` with mode `0755`.

- [ ] **Step 2: Write failing device-login tests**

Use a fake process emitting a URL and user code; assert only `https://auth.openai.com/` or `https://chatgpt.com/` URLs are exposed, one login runs at a time, and cancel/expiry are fixed public messages.

- [ ] **Step 3: Implement provider setup**

Start bundled Codex with:

```text
codex login --device-auth
```

Capture a bounded stream, expose an allow-listed URL and display code, poll `codex login status`, then update the setup snapshot. Keep Claude/Trae cards as optional advanced choices.

- [ ] **Step 4: Replace terminal commands in the primary UI**

The AI step primary action becomes `连接 ChatGPT`; external CLIs move under “使用其他 AI”. The user should not see npm, Homebrew, PATH or model IDs in the primary journey.

- [ ] **Step 5: Run and commit**

```bash
bun test packages/llm/src/provider-setup.test.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
git add packages/llm/src/provider-setup.ts packages/llm/src/provider-setup.test.ts packages/llm/src/providers.ts packages/web/src/setup-view.ts packages/web/src/app.ts
git commit -m "feat: connect ChatGPT without terminal setup"
```

### Task 7: Sign, notarize and publish architecture-specific DMGs

**Files:**
- Create: `.github/workflows/release-macos.yml`
- Create: `scripts/write-update-manifest.ts`
- Create: `scripts/smoke-macos-bundle.ts`

- [ ] **Step 1: Add release workflow validation**

The workflow triggers only on `v*` tags and runs `bun install --frozen-lockfile`, tests and typecheck before matrix builds for `arm64` and `x64`.

- [ ] **Step 2: Sign and notarize**

Import the Developer ID certificate from encrypted GitHub secrets, sign nested executables before the app, create a compressed DMG, submit with `xcrun notarytool submit --wait`, staple, then verify with both `codesign --verify --deep --strict` and `spctl --assess --type open`.

- [ ] **Step 3: Generate an update manifest**

Publish JSON shaped exactly as:

```json
{
  "version": "0.1.0-beta.1",
  "minimumMacOS": "13.0",
  "artifacts": {
    "arm64": { "url": "https://github.com/zhangga/homebrain/releases/download/v0.1.0-beta.1/Homebrain-0.1.0-beta.1-macos-arm64.dmg", "sha256": "64-lowercase-hex" },
    "x64": { "url": "https://github.com/zhangga/homebrain/releases/download/v0.1.0-beta.1/Homebrain-0.1.0-beta.1-macos-x64.dmg", "sha256": "64-lowercase-hex" }
  }
}
```

The script must reject placeholder hashes and non-HTTPS URLs.

- [ ] **Step 4: Run isolated smoke tests**

Mount the DMG, copy the app to a temporary Applications directory, launch with temporary HOME/data/port, require `/healthz` 200 and `/setup` HTML, then stop gracefully and verify no files were written inside the app bundle.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-macos.yml scripts/write-update-manifest.ts scripts/smoke-macos-bundle.ts
git commit -m "ci: publish signed Homebrain macOS releases"
```

### Task 8: Add guarded update and uninstall UX

**Files:**
- Create: `packages/app/src/updater.ts`
- Create: `packages/app/src/updater.test.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/app/src/service.ts`

- [ ] **Step 1: Write failure-first updater tests**

Cover invalid signature, wrong architecture, downgrade, checksum mismatch, interrupted staging, successful replacement and rollback.

- [ ] **Step 2: Implement safe staging**

Download to `~/Library/Application Support/Homebrain/updates/<version>`, verify manifest URL, SHA-256, Apple signature and bundle id, then ask for explicit confirmation. Stop the service, replace the app atomically through a helper process, restart, wait for `/readyz`, and restore the previous bundle if health does not return.

- [ ] **Step 3: Implement uninstall choices**

Offer two actions:

```text
移除应用，保留知识数据
彻底移除应用和所有本地知识
```

The destructive option requires typing `删除 Homebrain` and creates a final export prompt before deletion.

- [ ] **Step 4: Run full verification**

```bash
bun test
bunx tsc -p tsconfig.json --noEmit
bun run build:macos --target "$(uname -m)"
bun run smoke:macos
```

Expected: all tests pass, bundle launches from outside the repository, setup renders, and stop/uninstall leave no orphan LaunchAgent.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/updater.ts packages/app/src/updater.test.ts packages/web/src/views.ts packages/web/src/app.ts packages/app/src/service.ts
git commit -m "feat: update and uninstall Homebrain safely"
```

## Acceptance checklist

- A clean macOS 13+ account can install Homebrain without Terminal, Git, Bun, Node or npm.
- Dragging or updating the app does not move or delete knowledge data.
- First launch opens the guided setup and can connect ChatGPT plus create a Feishu bot through browser authorization.
- Every redistributed binary has a pinned version, verified checksum and license notice.
- Gatekeeper accepts the DMG and app on both Apple Silicon and Intel.
- LaunchAgent survives logout/login, points only at the stable app bundle, and never stores provider or Feishu secrets.
- Update failure rolls back to the previous runnable bundle.
- Uninstall defaults to preserving data and makes destructive deletion unmistakable.
