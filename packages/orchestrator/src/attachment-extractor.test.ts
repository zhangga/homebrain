import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadedAttachment } from "@homebrain/connectors";
import {
  extractAttachmentText,
  type NativeExtractor,
} from "./attachment-extractor.ts";

describe("extractAttachmentText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-extract-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function attachment(
    name: string,
    kind: DownloadedAttachment["attachment"]["kind"] = "file",
  ): DownloadedAttachment {
    return {
      attachment: { kind, ref: `ref-${name}`, name },
      localPath: join(dir, "resource.bin"),
      sizeBytes: 0,
      cleanup: () => {},
    };
  }

  test("reads UTF-8 text-like attachments", async () => {
    const input = attachment("notes.md");
    writeFileSync(input.localPath, "项目代号是北极星", "utf8");

    expect(await extractAttachmentText(input)).toBe("项目代号是北极星");
  });

  test("returns null for empty or invalid UTF-8 text", async () => {
    const empty = attachment("empty.txt");
    writeFileSync(empty.localPath, " \n\t", "utf8");
    expect(await extractAttachmentText(empty)).toBeNull();

    const invalid = attachment("invalid.json");
    writeFileSync(invalid.localPath, Uint8Array.from([0xc3, 0x28]));
    expect(await extractAttachmentText(invalid)).toBeNull();
  });

  test("uses the native extractor for image and PDF content", async () => {
    const native: NativeExtractor = async (mode) => ({
      code: 0,
      stdout: mode === "image" ? "识别出的图片文字\n" : "PDF 文本层\n",
      stderr: "",
    });

    expect(await extractAttachmentText(attachment("scan.png", "image"), native)).toBe(
      "识别出的图片文字",
    );
    expect(await extractAttachmentText(attachment("brief.pdf", "pdf"), native)).toBe(
      "PDF 文本层",
    );
  });

  test("returns null when native extraction exits unsuccessfully", async () => {
    const failed: NativeExtractor = async () => ({
      code: 4,
      stdout: "partial output must be ignored",
      stderr: "bad document",
    });

    expect(await extractAttachmentText(attachment("broken.pdf", "pdf"), failed)).toBeNull();
  });

  test("bounds native output to 200,000 characters", async () => {
    const native: NativeExtractor = async () => ({
      code: 0,
      stdout: `${"识".repeat(200_001)}\n`,
      stderr: "",
    });

    const text = await extractAttachmentText(attachment("large.png", "image"), native);
    expect(text).toBe("识".repeat(200_000));
  });

  test("returns null for unsupported audio", async () => {
    const native: NativeExtractor = async () => ({
      code: 0,
      stdout: "audio should not use the native extractor",
      stderr: "",
    });

    expect(await extractAttachmentText(attachment("voice.opus", "audio"), native)).toBeNull();
  });

  test("contains read and native boundary failures", async () => {
    const missing = attachment("missing.log");
    expect(await extractAttachmentText(missing)).toBeNull();

    const throws: NativeExtractor = async () => {
      throw new Error("spawn failed");
    };
    expect(await extractAttachmentText(attachment("scan.png", "image"), throws)).toBeNull();
  });
});
