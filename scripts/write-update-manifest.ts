import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface UpdateArtifact {
  url: string;
  sha256: string;
}

export interface UpdateManifest {
  version: string;
  minimumMacOS: "13.0";
  artifacts: {
    arm64: UpdateArtifact;
    x64: UpdateArtifact;
  };
}

function artifact(path: string, url: string): UpdateArtifact {
  if (!existsSync(path)) throw new Error(`release artifact does not exist: ${basename(path)}`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("update artifacts must use HTTPS GitHub release URLs");
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(sha256) || /^0{64}$/.test(sha256)) {
    throw new Error("invalid release artifact SHA-256");
  }
  return { url: parsed.toString(), sha256 };
}

export function createUpdateManifest(input: {
  version: string;
  repository: string;
  arm64Path: string;
  x64Path: string;
}): UpdateManifest {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error("version must be semantic and path-safe");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("repository must be a GitHub owner/name pair");
  }
  const file = (arch: "arm64" | "x64") => `HomeAgent-${input.version}-macos-${arch}.dmg`;
  const base = `https://github.com/${input.repository}/releases/download/v${input.version}`;
  return {
    version: input.version,
    minimumMacOS: "13.0",
    artifacts: {
      arm64: artifact(input.arm64Path, `${base}/${file("arm64")}`),
      x64: artifact(input.x64Path, `${base}/${file("x64")}`),
    },
  };
}

function value(args: string[], flag: string): string {
  const at = args.indexOf(flag);
  const result = at >= 0 ? args[at + 1] : undefined;
  if (!result) throw new Error(`missing ${flag}`);
  return result;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const output = resolve(value(args, "--output"));
    const manifest = createUpdateManifest({
      version: value(args, "--version"),
      repository: value(args, "--repository"),
      arm64Path: resolve(value(args, "--arm64")),
      x64Path: resolve(value(args, "--x64")),
    });
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    console.log(output);
  } catch (error) {
    console.error(`write-update-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
