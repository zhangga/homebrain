import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { DownloadedAttachment } from "@homebrain/connectors";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
]);
const MAX_OUTPUT_CHARS = 200_000;
const NATIVE_TIMEOUT_MS = 60_000;

export interface NativeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type NativeExtractor = (
  mode: "image" | "pdf",
  path: string,
) => Promise<NativeResult>;

export async function extractAttachmentText(
  input: DownloadedAttachment,
  runNative: NativeExtractor = defaultNativeExtractor,
): Promise<string | null> {
  try {
    const extension = extname(input.attachment.name ?? "").toLowerCase();
    if (input.attachment.kind === "file" && TEXT_EXTENSIONS.has(extension)) {
      const bytes = readFileSync(input.localPath);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      return decoded ? decoded.slice(0, MAX_OUTPUT_CHARS) : null;
    }

    const mode = input.attachment.kind === "image"
      ? "image"
      : input.attachment.kind === "pdf"
        ? "pdf"
        : undefined;
    if (!mode || process.platform !== "darwin") return null;

    const result = await runNative(mode, input.localPath);
    if (result.code !== 0) return null;
    const text = result.stdout.trim();
    return text ? text.slice(0, MAX_OUTPUT_CHARS) : null;
  } catch {
    return null;
  }
}

async function defaultNativeExtractor(
  mode: "image" | "pdf",
  path: string,
): Promise<NativeResult> {
  const script = join(import.meta.dir, "attachment-extract.swift");
  const directory = mkdtempSync(join(tmpdir(), "homebrain-native-extract-"));
  const binary = join(directory, "attachment-extract");
  const startedAt = Date.now();
  try {
    const compilation = await runBoundedProcess(
      ["/usr/bin/xcrun", "swiftc", script, "-o", binary],
      NATIVE_TIMEOUT_MS,
    );
    if (compilation.code !== 0) return compilation;

    const remainingMs = NATIVE_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return { code: null, stdout: "", stderr: "native extraction timed out" };
    }
    return await runBoundedProcess([binary, mode, path], remainingMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runBoundedProcess(
  command: string[],
  timeoutMs: number,
): Promise<NativeResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // The process may have exited between the timeout and this callback.
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
