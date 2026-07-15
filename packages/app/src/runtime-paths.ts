import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { brandedEnv } from "@homeagent/shared";

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
  const explicitAppRoot = brandedEnv(env, "BUNDLED_APP_ROOT")?.trim();
  const marker = ".app/Contents/MacOS/";
  const markerAt = execPath.indexOf(marker);
  const bundled = Boolean(explicitAppRoot) || markerAt >= 0;
  const appRoot = bundled
    ? resolve(explicitAppRoot || execPath.slice(0, markerAt + 4))
    : resolve(input.repoRoot ?? join(import.meta.dir, "../../.."));
  const resourceDir = bundled
    ? join(appRoot, "Contents", "Resources")
    : join(appRoot, "packages", "orchestrator", "src");
  const dataDir = resolve(
    brandedEnv(env, "DATA_DIR") ??
      (bundled
        ? join(home, "Library", "Application Support", "HomeAgent")
        : join(appRoot, "data")),
  );
  const logDir = resolve(
    brandedEnv(env, "LOG_DIR")
      ?? (bundled ? join(home, "Library", "Logs", "HomeAgent") : join(dataDir, "logs")),
  );

  return {
    bundled,
    appRoot,
    resourceDir,
    dataDir,
    logDir,
    larkBin:
      brandedEnv(env, "LARK_BIN") ??
      (bundled ? join(resourceDir, "bin", "lark-cli") : "lark-cli"),
    attachmentHelper: bundled
      ? join(resourceDir, "bin", "attachment-extract")
      : undefined,
  };
}
