import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CodexProviderSetup,
  CodexReleaseInstaller,
  GitHubCodexReleaseDiscovery,
  codexTargetForArchitecture,
  type CodexInstallFileSystem,
  type CodexInstallNetwork,
  type CodexLoginProcess,
  type CodexRelease,
} from "./provider-setup.ts";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(2);
    }
  }
}

const activeSetups: CodexProviderSetup[] = [];

afterEach(() => {
  for (const setup of activeSetups) setup.cancelDeviceLogin();
  activeSetups.length = 0;
});

describe("CodexProviderSetup", () => {
  test("starts one device login and exposes only a safe URL and user code", async () => {
    const exited = deferred<number>();
    let spawned: string[] | undefined;
    let spawnCount = 0;
    const setup = new CodexProviderSetup({
      codexBin: "/managed/codex",
      detailWaitMs: 50,
      ttlMs: 1_000,
      spawner: {
        spawn(argv) {
          spawned = argv;
          spawnCount += 1;
          return {
            stdout: chunks("internal trace that must not escape\n"),
            stderr: chunks(
              "x".repeat(9_000),
              "Open https://auth.openai.",
              "com/codex/device and enter user code ABCD-EFGH\n",
            ),
            exited: exited.promise,
            kill: () => exited.resolve(143),
          };
        },
      },
      commandRunner: {
        run: async () => ({ code: 1, stdout: "", stderr: "not logged in" }),
      },
    });
    activeSetups.push(setup);

    const first = await setup.startDeviceLogin();
    const duplicate = await setup.startDeviceLogin();

    expect(spawned).toEqual([
      "/managed/codex",
      "-c",
      'cli_auth_credentials_store="keyring"',
      "login",
      "--device-auth",
    ]);
    expect(spawnCount).toBe(1);
    expect(first).toEqual(expect.objectContaining({
      state: "waiting_for_user",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    }));
    expect(duplicate.startedAt).toBe(first.startedAt);
    expect(JSON.stringify(first)).not.toContain("internal trace");
  });

  test("ignores untrusted URLs and never surfaces child-process output", async () => {
    const setup = new CodexProviderSetup({
      detailWaitMs: 50,
      spawner: {
        spawn: () => ({
          stdout: chunks("https://attacker.example/device?token=secret\nuser code SECRET_TOKEN\n"),
          stderr: chunks("raw credential material\n"),
          exited: Promise.resolve(1),
          kill: () => {},
        }),
      },
      commandRunner: {
        run: async () => ({ code: 1, stdout: "", stderr: "unused" }),
      },
    });
    activeSetups.push(setup);

    const session = await setup.startDeviceLogin();

    expect(session.state).toBe("failed");
    expect(session.verificationUrl).toBeUndefined();
    expect(session.userCode).toBeUndefined();
    expect(session.message).toBe("ChatGPT 登录未完成，请重试");
    expect(JSON.stringify(session)).not.toContain("secret");
    expect(JSON.stringify(session)).not.toContain("credential");
  });

  test("becomes ready only after codex login status succeeds", async () => {
    const exited = deferred<number>();
    const commands: string[][] = [];
    const setup = new CodexProviderSetup({
      codexBin: "/managed/codex",
      detailWaitMs: 50,
      ttlMs: 1_000,
      spawner: {
        spawn: () => ({
          stdout: chunks("Visit https://chatgpt.com/device\nCode: WXYZ-1234\n"),
          stderr: chunks(""),
          exited: exited.promise,
          kill: () => exited.resolve(143),
        }),
      },
      commandRunner: {
        async run(argv) {
          commands.push(argv);
          return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
        },
      },
    });
    activeSetups.push(setup);

    expect((await setup.startDeviceLogin()).state).toBe("waiting_for_user");
    exited.resolve(0);
    await eventually(() => expect(setup.deviceLoginStatus().state).toBe("ready"));

    expect(commands).toEqual([[
      "/managed/codex",
      "-c",
      'cli_auth_credentials_store="keyring"',
      "login",
      "status",
    ]]);
    expect(setup.deviceLoginStatus().message).toBe("ChatGPT 已连接");
  });

  test("cancels and expires with fixed public messages", async () => {
    const makeSetup = (ttlMs: number) => {
      let kills = 0;
      const exited = deferred<number>();
      const setup = new CodexProviderSetup({
        detailWaitMs: 50,
        ttlMs,
        spawner: {
          spawn: (): CodexLoginProcess => ({
            stdout: chunks("https://auth.openai.com/device\nUser code: SAFE-CODE\n"),
            stderr: chunks("private output"),
            exited: exited.promise,
            kill: () => {
              kills += 1;
              exited.resolve(143);
            },
          }),
        },
        commandRunner: {
          run: async () => ({ code: 1, stdout: "", stderr: "unused" }),
        },
      });
      activeSetups.push(setup);
      return { setup, kills: () => kills };
    };

    const cancelled = makeSetup(1_000);
    await cancelled.setup.startDeviceLogin();
    expect(cancelled.setup.cancelDeviceLogin()).toEqual(expect.objectContaining({
      state: "cancelled",
      message: "已取消 ChatGPT 登录",
    }));
    expect(cancelled.kills()).toBe(1);

    const expired = makeSetup(10);
    await expired.setup.startDeviceLogin();
    await eventually(() => expect(expired.setup.deviceLoginStatus().state).toBe("expired"));
    expect(expired.setup.deviceLoginStatus().message).toBe("ChatGPT 登录已过期，请重试");
    expect(expired.kills()).toBe(1);
  });
});

describe("CodexReleaseInstaller", () => {
  test("maps supported macOS architectures to official release targets", () => {
    expect(codexTargetForArchitecture("arm64")).toBe("aarch64-apple-darwin");
    expect(codexTargetForArchitecture("x64")).toBe("x86_64-apple-darwin");
    expect(() => codexTargetForArchitecture("ia32")).toThrow("不支持");
  });

  test("installs a verified official release through staging and atomic rename", async () => {
    const archive = new TextEncoder().encode("official codex archive");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const release: CodexRelease = {
      version: "0.144.4",
      assetName: "codex-aarch64-apple-darwin.tar.gz",
      downloadUrl:
        "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
      sha256,
    };
    const operations: Array<{ op: string; args: unknown[] }> = [];
    const files: CodexInstallFileSystem = {
      mkdir: async (...args) => { operations.push({ op: "mkdir", args }); },
      writeFile: async (...args) => { operations.push({ op: "writeFile", args }); },
      extractTarGz: async (...args) => { operations.push({ op: "extractTarGz", args }); },
      assertRegularFile: async (...args) => { operations.push({ op: "assertRegularFile", args }); },
      chmod: async (...args) => { operations.push({ op: "chmod", args }); },
      rename: async (...args) => { operations.push({ op: "rename", args }); },
      remove: async (...args) => { operations.push({ op: "remove", args }); },
    };
    let discoveredTarget: string | undefined;
    const network: CodexInstallNetwork = {
      getJson: async () => { throw new Error("unused"); },
      download: async (url) => {
        expect(url).toBe(release.downloadUrl);
        return archive;
      },
    };
    const installer = new CodexReleaseInstaller({
      dataDir: "/Users/me/Library/Application Support/HomeAgent",
      architecture: "arm64",
      network,
      files,
      releaseDiscovery: {
        async latest(target) {
          discoveredTarget = target;
          return release;
        },
      },
      stagingId: () => "test-stage",
      now: () => 1_784_000_000_000,
    });

    const result = await installer.installAfterConsent(true);

    expect(discoveredTarget).toBe("aarch64-apple-darwin");
    expect(result).toEqual({
      path: "/Users/me/Library/Application Support/HomeAgent/bin/codex",
      version: "0.144.4",
      sourceUrl: release.downloadUrl,
      sha256,
      installedAt: 1_784_000_000_000,
    });
    expect(operations).toContainEqual({
      op: "chmod",
      args: [
        "/Users/me/Library/Application Support/HomeAgent/bin/.codex-install-test-stage/codex-aarch64-apple-darwin",
        0o755,
      ],
    });
    expect(operations).toContainEqual({
      op: "rename",
      args: [
        "/Users/me/Library/Application Support/HomeAgent/bin/.codex-install-test-stage/codex-aarch64-apple-darwin",
        "/Users/me/Library/Application Support/HomeAgent/bin/codex",
      ],
    });
    expect(operations).toContainEqual({
      op: "rename",
      args: [
        "/Users/me/Library/Application Support/HomeAgent/bin/.codex-install-test-stage/codex-install.json",
        "/Users/me/Library/Application Support/HomeAgent/bin/codex-install.json",
      ],
    });
    expect(operations.at(-1)).toEqual({
      op: "remove",
      args: [
        "/Users/me/Library/Application Support/HomeAgent/bin/.codex-install-test-stage",
      ],
    });
    const receiptWrite = operations.find(({ op, args }) =>
      op === "writeFile" && String(args[0]).endsWith("codex-install.json"));
    expect(receiptWrite).toBeDefined();
    expect(new TextDecoder().decode(receiptWrite!.args[1] as Uint8Array)).toContain(release.downloadUrl);
  });

  test("requires consent and rejects checksum or release-origin failures before replacement", async () => {
    const bytes = new TextEncoder().encode("tampered");
    let discoveryCalls = 0;
    let downloadCalls = 0;
    let renameCalls = 0;
    const files: CodexInstallFileSystem = {
      mkdir: async () => {},
      writeFile: async () => {},
      extractTarGz: async () => {},
      assertRegularFile: async () => {},
      chmod: async () => {},
      rename: async () => { renameCalls += 1; },
      remove: async () => {},
    };
    const release = (downloadUrl: string): CodexRelease => ({
      version: "0.144.4",
      assetName: "codex-aarch64-apple-darwin.tar.gz",
      downloadUrl,
      sha256: "0".repeat(64),
    });
    let current = release(
      "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
    );
    const installer = new CodexReleaseInstaller({
      dataDir: "/data",
      architecture: "arm64",
      files,
      network: {
        getJson: async () => ({}),
        download: async () => { downloadCalls += 1; return bytes; },
      },
      releaseDiscovery: {
        latest: async () => { discoveryCalls += 1; return current; },
      },
      stagingId: () => "test",
    });

    await expect(installer.installAfterConsent(false)).rejects.toMatchObject({
      code: "consent_required",
      message: "需要你确认后才能安装 Codex",
    });
    expect(discoveryCalls).toBe(0);

    await expect(installer.installAfterConsent(true)).rejects.toMatchObject({
      code: "checksum_mismatch",
      message: "Codex 下载校验失败，请重试",
    });
    expect(renameCalls).toBe(0);

    current = release("https://attacker.example/codex.tar.gz");
    await expect(installer.installAfterConsent(true)).rejects.toMatchObject({
      code: "invalid_release",
      message: "无法验证 Codex 官方版本",
    });
    expect(downloadCalls).toBe(1);
    expect(renameCalls).toBe(0);
  });

  test("discovers the exact official asset and GitHub-published digest", async () => {
    const requested: string[] = [];
    const network: CodexInstallNetwork = {
      async getJson(url) {
        requested.push(url);
        return {
          tag_name: "rust-v0.144.4",
          assets: [
            {
              name: "codex-aarch64-apple-darwin.tar.gz",
              browser_download_url:
                "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
              digest: `sha256:${"a".repeat(64)}`,
            },
          ],
        };
      },
      download: async () => { throw new Error("unused"); },
    };

    const release = await new GitHubCodexReleaseDiscovery(network).latest(
      "aarch64-apple-darwin",
    );

    expect(requested).toEqual(["https://api.github.com/repos/openai/codex/releases/latest"]);
    expect(release).toEqual({
      version: "0.144.4",
      assetName: "codex-aarch64-apple-darwin.tar.gz",
      downloadUrl:
        "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
      sha256: "a".repeat(64),
    });
  });
});
