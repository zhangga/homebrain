import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REQUIRED = [
  "Contents/Info.plist",
  "Contents/MacOS/homeagent",
  "Contents/Resources/app/homeagent.js",
  "Contents/Resources/bin/bun",
  "Contents/Resources/bin/lark-cli",
  "Contents/Resources/bin/attachment-extract",
] as const;

export function inspectMacOSBundle(appPath: string): { appPath: string; files: string[] } {
  const resolved = resolve(appPath);
  if (!resolved.endsWith(".app")) throw new Error("bundle path must end in .app");
  const files = REQUIRED.map((file) => join(resolved, file));
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`bundle is missing ${file.slice(resolved.length + 1)}`);
  }
  return { appPath: resolved, files };
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
      else hash.update("non-file");
    }
  };
  visit(root);
  return hash.digest("hex");
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a smoke-test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      lastStatus = response.status;
      if (response.ok) return response;
    } catch {
      // The standalone process is expected to be briefly unavailable.
    }
    await Bun.sleep(200);
  }
  throw new Error(`smoke probe timed out${lastStatus ? ` (last status ${lastStatus})` : ""}`);
}

export async function smokeMacOSBundle(appPath: string, timeoutMs = 20_000): Promise<void> {
  const source = inspectMacOSBundle(appPath).appPath;
  const root = mkdtempSync(join(tmpdir(), "homeagent-smoke-"));
  const home = join(root, "home");
  const installed = join(root, "Applications", basename(source));
  cpSync(source, installed, { recursive: true, preserveTimestamps: true });
  const before = digestTree(installed);
  const port = await freePort();
  const executable = join(installed, "Contents", "MacOS", "homeagent");
  const child = Bun.spawn([executable, "serve"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      HOME: home,
      HOMEAGENT_DATA_DIR: join(home, "Library", "Application Support", "HomeAgent"),
      HOMEAGENT_LOG_DIR: join(home, "Library", "Logs", "HomeAgent"),
      HOMEAGENT_WEB_HOST: "127.0.0.1",
      HOMEAGENT_WEB_PORT: String(port),
      HOMEAGENT_SERVICE_MANAGED: "0",
      HOMEAGENT_CLAUDE_BIN: join(root, "missing-claude"),
      HOMEAGENT_TRAE_BIN: join(root, "missing-trae"),
    },
  });
  try {
    try {
      await waitFor(`http://127.0.0.1:${port}/healthz`, timeoutMs);
      const setup = await waitFor(`http://127.0.0.1:${port}/setup`, timeoutMs);
      const body = await setup.text();
      if (!body.includes("homeagent") || !body.includes("设置进度")) {
        throw new Error("standalone setup page did not render the guided flow");
      }
      if (!body.includes("安装并连接 ChatGPT") || body.includes("npm install")) {
        throw new Error("standalone setup did not expose the zero-terminal AI flow");
      }
    } finally {
      child.kill("SIGTERM");
      await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => { throw new Error("standalone process did not stop after SIGTERM"); }),
      ]);
    }
    if (digestTree(installed) !== before) throw new Error("standalone process modified its app bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const at = process.argv.indexOf("--app");
    const app = at >= 0 ? process.argv[at + 1] : join(import.meta.dir, "..", "dist", "HomeAgent.app");
    if (!app) throw new Error("missing --app path");
    await smokeMacOSBundle(app);
    console.log(`Smoke test passed: ${resolve(app)}`);
  } catch (error) {
    console.error(`smoke:macos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
