# Multimodal Attachment Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download supported Feishu message attachments, extract useful text locally, and feed that text into homebrain's existing raw-message, dream-cycle, retention, export, and retraction paths.

**Architecture:** The Feishu connector remains the only module that knows `lark-cli`: it resolves resource keys from the raw message and downloads each resource into an isolated temporary directory. A platform-neutral extractor in the orchestrator reads text formats directly and uses a bounded macOS Vision/PDFKit helper for image OCR and PDF text. The orchestrator writes one additional `source: "message"` raw entry per successfully extracted attachment, preserving the original `messageId` so existing retraction and retention behavior applies unchanged.

**Tech Stack:** Bun/TypeScript, `lark-cli im +messages-resources-download --as bot`, macOS Swift 5.9 with Vision/PDFKit, Bun test, existing SQLite/raw/dream pipeline.

**Implementation status:** Complete. Review hardening added cancellable 30-second Feishu resource commands, in-progress file-size monitoring, bounded SIGTERM→SIGKILL termination, a 40-million-pixel image limit, and thinking-reaction coverage before slow attachment work. The native helper is compiled with `swiftc` into an isolated temporary directory because Swift script mode cannot link AppKit/PDFKit reliably. Live Feishu acceptance verified TXT, image OCR, and PDF ingestion; a Dream cycle examined six raw entries and wrote a knowledge page; retracting the TXT source removed both raw entries sharing its original message ID while leaving the image/PDF knowledge intact.

---

## First-version boundaries

- Supported direct Feishu message types: `image`, `file`, `audio`, and `media` for discovery/download.
- Extracted content: UTF-8 text-like files (`.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.log`), image OCR, and PDF text layers.
- Download safety: one isolated temp directory per resource, filename sanitization, and a 20 MiB post-download size limit.
- Output safety: at most 200,000 characters per attachment; invalid UTF-8 is rejected instead of producing corrupt knowledge.
- Unsupported in this slice: audio transcription, Office document conversion, video understanding, and images embedded inside `post` messages. Their metadata remains represented by the original Feishu message text; they do not produce an extracted raw entry.
- Failure policy: one failed resource is logged and skipped; the original message capture and any reply continue normally.

## File map

- Modify `packages/connectors/src/connector.ts`: public downloaded-attachment contract and optional connector capability.
- Modify `packages/connectors/src/feishu-normalize.ts`: retain `message_type`; parse raw Feishu resource descriptors.
- Modify `packages/connectors/src/feishu-normalize.test.ts`: normalization/resource parsing behavior.
- Modify `packages/connectors/src/feishu.ts`: raw-message lookup, safe temporary download, size cap, cleanup contract.
- Modify `packages/connectors/src/feishu.test.ts`: external `lark-cli` boundary tests.
- Create `packages/orchestrator/src/attachment-extractor.ts`: public extraction seam and bounded process runner.
- Create `packages/orchestrator/src/attachment-extractor.test.ts`: text and native-extractor behavior.
- Create `packages/orchestrator/src/attachment-extract.swift`: Vision/PDFKit helper.
- Modify `packages/orchestrator/src/runtime.ts`: attachment extraction into raw knowledge.
- Modify `packages/orchestrator/src/runtime.test.ts`: end-to-end raw capture and failure isolation.
- Modify `packages/app/src/main.ts`: production wiring uses the default extractor.
- Modify `README.md`: supported formats, limits, permissions, and operational behavior.

### Task 1: Preserve attachment intent and parse Feishu resource descriptors

**Files:**
- Modify: `packages/connectors/src/connector.ts`
- Modify: `packages/connectors/src/feishu-normalize.ts`
- Test: `packages/connectors/src/feishu-normalize.test.ts`

- [x] **Step 1: Write the failing normalization tests**

Add tests proving the public inbound envelope retains `message_type` and the raw-message parser accepts only known direct resource shapes:

```ts
test("retains the Feishu message type for attachment routing", () => {
  expect(normalizeMessage({ ...base, message_type: "image" })?.messageType).toBe("image");
});

test("extracts image and named file resources from raw message content", () => {
  expect(parseMessageResources("image", JSON.stringify({ image_key: "img_1" }))).toEqual([
    { kind: "image", fileKey: "img_1", resourceType: "image" },
  ]);
  expect(parseMessageResources("file", JSON.stringify({
    file_key: "file_1",
    file_name: "roadmap.pdf",
  }))).toEqual([
    { kind: "pdf", fileKey: "file_1", resourceType: "file", name: "roadmap.pdf" },
  ]);
});

test("malformed and unsupported resource content is ignored", () => {
  expect(parseMessageResources("text", JSON.stringify({ text: "hello" }))).toEqual([]);
  expect(parseMessageResources("file", "not-json")).toEqual([]);
  expect(parseMessageResources("file", JSON.stringify({ file_name: "missing-key.pdf" }))).toEqual([]);
});
```

- [x] **Step 2: Run the tests to verify red**

Run:

```bash
bun test packages/connectors/src/feishu-normalize.test.ts
```

Expected: failure because `InboundMessage.messageType` and `parseMessageResources` do not exist.

- [x] **Step 3: Add the connector contracts and parser**

Add these public contracts to `connector.ts`:

```ts
import type { Attachment } from "@homebrain/shared";

export interface DownloadedAttachment {
  attachment: Attachment;
  localPath: string;
  sizeBytes: number;
  cleanup(): void;
}

export interface InboundMessage {
  // existing fields stay unchanged
  messageType?: string;
}

export interface Connector {
  // existing methods stay unchanged
  downloadAttachments?(messageId: string): Promise<DownloadedAttachment[]>;
}
```

Add the pure descriptor parser to `feishu-normalize.ts`:

```ts
import type { Attachment } from "@homebrain/shared";

export interface FeishuMessageResource {
  kind: Attachment["kind"];
  fileKey: string;
  resourceType: "image" | "file";
  name?: string;
}

export function parseMessageResources(
  messageType: string | undefined,
  content: string | undefined,
): FeishuMessageResource[] {
  if (!messageType || !content || !["image", "file", "audio", "media"].includes(messageType)) {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  const imageKey = asString(parsed.image_key);
  const fileKey = asString(parsed.file_key);
  const name = asString(parsed.file_name);
  if (messageType === "image" && imageKey) {
    return [{ kind: "image", fileKey: imageKey, resourceType: "image" }];
  }
  if (!fileKey) return [];
  const kind: Attachment["kind"] = messageType === "audio"
    ? "audio"
    : name?.toLowerCase().endsWith(".pdf")
      ? "pdf"
      : "file";
  return [{ kind, fileKey, resourceType: "file", name }];
}
```

Map `message_type` in `normalizeMessage`:

```ts
messageType: asString(obj.message_type),
```

- [x] **Step 4: Run the tests to verify green**

Run:

```bash
bun test packages/connectors/src/feishu-normalize.test.ts
bun run typecheck
```

Expected: all normalization tests and typechecking pass.

- [x] **Step 5: Commit the contract slice**

```bash
git add packages/connectors/src/connector.ts packages/connectors/src/feishu-normalize.ts packages/connectors/src/feishu-normalize.test.ts
git commit -m "feat: add Feishu attachment descriptors"
```

### Task 2: Download Feishu resources safely through the connector

**Files:**
- Modify: `packages/connectors/src/feishu.ts`
- Test: `packages/connectors/src/feishu.test.ts`

- [x] **Step 1: Write the failing connector contract test**

Use the existing injected command boundary. The mock writes a small fixture into the supplied working directory, while assertions observe only the public `downloadAttachments()` result:

```ts
test("downloads a message resource with bot identity and returns a cleanup handle", async () => {
  const commands: string[][] = [];
  const connector = new FeishuConnector({
    identity: {},
    runCommand: async (cmd, opts) => {
      commands.push(cmd);
      if (cmd.includes("/open-apis/im/v1/messages/om_file")) {
        return JSON.stringify({ data: { items: [{
          message_id: "om_file",
          msg_type: "file",
          body: { content: JSON.stringify({ file_key: "file_1", file_name: "notes.txt" }) },
        }] } });
      }
      await Bun.write(join(opts!.cwd!, "resource.bin"), "project codename is Polaris");
      return JSON.stringify({ ok: true });
    },
  });

  const [download] = await connector.downloadAttachments("om_file");
  expect(download?.attachment).toEqual({ kind: "file", ref: "file_1", name: "notes.txt" });
  expect(await Bun.file(download!.localPath).text()).toBe("project codename is Polaris");
  expect(commands[1]).toEqual(expect.arrayContaining([
    "im", "+messages-resources-download", "--as", "bot",
    "--message-id", "om_file", "--file-key", "file_1", "--type", "file",
  ]));
  const parent = dirname(download!.localPath);
  download!.cleanup();
  expect(existsSync(parent)).toBe(false);
});
```

Add a second test with `maxAttachmentBytes: 10` whose mock writes 11 bytes; assert the method returns `[]` and removes the temp directory. Production keeps a 20 MiB default without making the test allocate 20 MiB.

- [x] **Step 2: Run the connector test to verify red**

```bash
bun test packages/connectors/src/feishu.test.ts --test-name-pattern "downloads a message resource|oversized attachment"
```

Expected: failure because `downloadAttachments` and command working-directory options are absent.

- [x] **Step 3: Implement bounded temporary downloads**

Extend the injected boundary:

```ts
interface CommandOptions { cwd?: string }
type RunCommand = (cmd: string[], opts?: CommandOptions) => Promise<string>;
```

Extend `FeishuConnectorOptions` with `maxAttachmentBytes?: number`, initialize a private field with `opts.maxAttachmentBytes ?? 20 * 1024 * 1024`, and extend `FetchedMessage` with `msg_type?: string` and `body?: { content?: string }`. Implement the public method:

```ts
async downloadAttachments(messageId: string): Promise<DownloadedAttachment[]> {
  const message = await this.fetchMessage(messageId);
  const resources = parseMessageResources(message?.msg_type, message?.body?.content);
  const downloads: DownloadedAttachment[] = [];
  for (const resource of resources) {
    const directory = mkdtempSync(join(tmpdir(), "homebrain-attachment-"));
    const output = "resource.bin";
    try {
      await this.runCommand([
        this.larkBin,
        "im",
        "+messages-resources-download",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--file-key",
        resource.fileKey,
        "--type",
        resource.resourceType,
        "--output",
        output,
        "--json",
      ], { cwd: directory });
      const localPath = join(directory, output);
      const sizeBytes = statSync(localPath).size;
      if (sizeBytes > this.maxAttachmentBytes) {
        rmSync(directory, { recursive: true, force: true });
        log.warn("attachment exceeds size limit", { messageId, sizeBytes });
        continue;
      }
      downloads.push({
        attachment: { kind: resource.kind, ref: resource.fileKey, name: resource.name },
        localPath,
        sizeBytes,
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
      });
    } catch (err) {
      rmSync(directory, { recursive: true, force: true });
      log.warn("attachment download failed", { messageId, fileKey: resource.fileKey, err: String(err) });
    }
  }
  return downloads;
}
```

Pass `opts?.cwd` into `Bun.spawn` in `defaultRunCommand`.

- [x] **Step 4: Run connector tests and typechecking**

```bash
bun test packages/connectors/src/feishu.test.ts packages/connectors/src/feishu-normalize.test.ts
bun run typecheck
```

Expected: connector/normalization tests and typechecking pass.

- [x] **Step 5: Commit the download slice**

```bash
git add packages/connectors/src/feishu.ts packages/connectors/src/feishu.test.ts
git commit -m "feat: download Feishu message attachments"
```

### Task 3: Extract bounded text from text, image, and PDF attachments

**Files:**
- Create: `packages/orchestrator/src/attachment-extractor.ts`
- Create: `packages/orchestrator/src/attachment-extractor.test.ts`
- Create: `packages/orchestrator/src/attachment-extract.swift`

- [x] **Step 1: Write the failing public extractor tests**

```ts
test("reads a UTF-8 text attachment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-extract-"));
  const localPath = join(dir, "resource.bin");
  writeFileSync(localPath, "项目代号是北极星", "utf8");
  expect(await extractAttachmentText({
    attachment: { kind: "file", ref: "file_1", name: "notes.md" },
    localPath,
    sizeBytes: 27,
    cleanup: () => {},
  })).toBe("项目代号是北极星");
  rmSync(dir, { recursive: true, force: true });
});

test("uses the native boundary for image OCR and bounds its output", async () => {
  const text = await extractAttachmentText(
    {
      attachment: { kind: "image", ref: "img_1" },
      localPath: "/tmp/image.bin",
      sizeBytes: 100,
      cleanup: () => {},
    },
    async () => ({ code: 0, stdout: `${"识别文字".repeat(30_000)}\n`, stderr: "" }),
  );
  expect(text?.length).toBe(200_000);
});

test("returns null for unsupported audio and native extraction failure", async () => {
  expect(await extractAttachmentText({
    attachment: { kind: "audio", ref: "file_audio", name: "voice.opus" },
    localPath: "/tmp/voice.opus",
    sizeBytes: 100,
    cleanup: () => {},
  })).toBeNull();
  expect(await extractAttachmentText(
    {
      attachment: { kind: "pdf", ref: "file_pdf", name: "x.pdf" },
      localPath: "/tmp/x.pdf",
      sizeBytes: 100,
      cleanup: () => {},
    },
    async () => ({ code: 1, stdout: "", stderr: "bad pdf" }),
  )).toBeNull();
});
```

- [x] **Step 2: Run extractor tests to verify red**

```bash
bun test packages/orchestrator/src/attachment-extractor.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Implement the TypeScript extraction seam**

Create `attachment-extractor.ts` with this public surface:

```ts
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { DownloadedAttachment } from "@homebrain/connectors";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const MAX_OUTPUT_CHARS = 200_000;

export interface NativeResult { code: number | null; stdout: string; stderr: string }
export type NativeExtractor = (mode: "image" | "pdf", path: string) => Promise<NativeResult>;

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

async function defaultNativeExtractor(mode: "image" | "pdf", path: string): Promise<NativeResult> {
  const script = join(import.meta.dir, "attachment-extract.swift");
  const proc = Bun.spawn(["/usr/bin/swift", script, mode, path], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
```

Catch invalid UTF-8 and process-spawn errors inside `extractAttachmentText` and return `null`; the caller must never lose the original message because extraction failed.

- [x] **Step 4: Implement and typecheck the native helper**

Create `attachment-extract.swift` with bounded PDFKit/Vision behavior:

```swift
import AppKit
import Foundation
import PDFKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3 else { exit(2) }
let mode = arguments[1]
let url = URL(fileURLWithPath: arguments[2])

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

func cgImage(_ image: NSImage) -> CGImage? {
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

do {
    if mode == "image" {
        guard let image = NSImage(contentsOf: url), let cg = cgImage(image) else { exit(3) }
        print(try recognize(cg))
    } else if mode == "pdf" {
        guard let document = PDFDocument(url: url) else { exit(3) }
        var parts: [String] = []
        for index in 0..<min(document.pageCount, 50) {
            guard let page = document.page(at: index) else { continue }
            if let text = page.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parts.append(text)
            }
        }
        print(parts.joined(separator: "\n\n"))
    } else {
        exit(2)
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(4)
}
```

Run:

```bash
xcrun swiftc -typecheck packages/orchestrator/src/attachment-extract.swift
bun test packages/orchestrator/src/attachment-extractor.test.ts
bun run typecheck
```

Expected: Swift typecheck, extractor tests, and TypeScript typecheck pass.

- [x] **Step 5: Commit the extractor slice**

```bash
git add packages/orchestrator/src/attachment-extractor.ts packages/orchestrator/src/attachment-extractor.test.ts packages/orchestrator/src/attachment-extract.swift
git commit -m "feat: extract text from local attachments"
```

### Task 4: Feed extracted attachments into the existing knowledge lifecycle

**Files:**
- Modify: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`
- Modify: `packages/app/src/main.ts`

- [x] **Step 1: Write the failing orchestrator integration tests**

Use the public runtime injection and engine seams. Recreate the test orchestrator with a temporary attachment downloader, then inspect the complete exported space rather than the internal SQLite implementation:

```ts
test("attachment text becomes message raw material with retraction provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hb-runtime-attachment-"));
  const localPath = join(directory, "resource.bin");
  writeFileSync(localPath, "项目代号是北极星", "utf8");
  const attachmentDownloader = async () => [{
    attachment: { kind: "file", ref: "file_1", name: "notes.txt" },
    localPath,
    sizeBytes: 27,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }];

  await orch.stop();
  orch = new Orchestrator({ engine, connector, llm: fake, attachmentDownloader });
  await orch.start();

  await connector.inject({
    kind: "message",
    eventId: "attachment-1",
    chatType: "group",
    chatId: "oc_team",
    senderId: "ou_me",
    text: "[文件] notes.txt",
    messageId: "om_attachment",
    messageType: "file",
    mentionsBot: false,
    createdAt: Date.now(),
  });

  const archive = await engine.exportSpace("team/oc_team");
  expect(archive.raw).toEqual(expect.arrayContaining([
    expect.objectContaining({
      messageId: "om_attachment",
      content: expect.stringContaining("项目代号是北极星"),
      attachments: [{ kind: "file", ref: "file_1", name: "notes.txt" }],
    }),
  ]));
  expect(existsSync(directory)).toBe(false);
});
```

Add a second test where `downloadAttachments` or the extractor throws; assert the original text raw entry still exists and event handling resolves without throwing.

- [x] **Step 2: Run the integration tests to verify red**

```bash
bun test packages/orchestrator/src/runtime.test.ts --test-name-pattern "attachment text|attachment extraction failure"
```

Expected: failure because runtime does not download or extract attachments.

- [x] **Step 3: Wire the extractor into runtime**

Add an injectable public seam while defaulting production to the real extractor:

```ts
import type { DownloadedAttachment } from "@homebrain/connectors";
import { extractAttachmentText } from "./attachment-extractor.ts";

export interface RuntimeOptions {
  // existing fields stay unchanged
  attachmentDownloader?: (messageId: string) => Promise<DownloadedAttachment[]>;
  attachmentExtractor?: (attachment: DownloadedAttachment) => Promise<string | null>;
}

private attachmentDownloader?: (messageId: string) => Promise<DownloadedAttachment[]>;
private attachmentExtractor: (attachment: DownloadedAttachment) => Promise<string | null>;

// constructor
this.attachmentDownloader = opts.attachmentDownloader
  ?? this.connector.downloadAttachments?.bind(this.connector);
this.attachmentExtractor = opts.attachmentExtractor ?? extractAttachmentText;
```

After the original message capture and before intent classification, call a new method only for direct attachment message types:

```ts
if (
  decision.capture
  && msg.messageType
  && ["image", "file", "audio", "media"].includes(msg.messageType)
  && this.attachmentDownloader
) {
  await this.syncAttachments(msg, writeSpace);
}
```

The method must preserve provenance and always clean up:

```ts
private async syncAttachments(msg: InboundMessage, writeSpace: SpaceId): Promise<void> {
  let downloads: DownloadedAttachment[] = [];
  try {
    downloads = await this.attachmentDownloader?.(msg.messageId) ?? [];
    for (const download of downloads) {
      try {
        const extracted = await this.attachmentExtractor(download);
        if (!extracted?.trim()) continue;
        const name = download.attachment.name ?? download.attachment.ref;
        await this.engine.remember({
          space: writeSpace,
          source: "message",
          author: msg.senderId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          content: `# 附件：${name}\n\n${extracted.trim()}`,
          attachments: [download.attachment],
          createdAt: msg.createdAt,
        });
      } catch (err) {
        log.warn("attachment extraction failed", { messageId: msg.messageId, err: String(err) });
      } finally {
        try {
          download.cleanup();
        } catch (cleanupErr) {
          log.warn("attachment cleanup failed", { messageId: msg.messageId, err: String(cleanupErr) });
        }
      }
    }
  } catch (err) {
    for (const download of downloads) {
      try {
        download.cleanup();
      } catch (cleanupErr) {
        log.warn("attachment cleanup failed", { messageId: msg.messageId, err: String(cleanupErr) });
      }
    }
    log.warn("attachment sync failed", { messageId: msg.messageId, err: String(err) });
  }
}
```

No extra production option is needed in `main.ts` because the runtime default is the local extractor; update the assembly comment to mention attachment ingestion.

- [x] **Step 4: Run orchestrator and provenance regressions**

```bash
bun test packages/orchestrator/src/runtime.test.ts packages/core/src/governance.test.ts packages/core/src/engine.test.ts
bun run typecheck
```

Expected: attachment integration, existing retraction/export tests, and typechecking pass.

- [x] **Step 5: Commit the lifecycle slice**

```bash
git add packages/orchestrator/src/runtime.ts packages/orchestrator/src/runtime.test.ts packages/app/src/main.ts
git commit -m "feat: ingest extracted Feishu attachments"
```

### Task 5: Document and verify the first P2 slice

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the product and operations documentation**

Document all of the following explicitly:

```md
- Direct Feishu image/file messages are resolved with bot identity and `im:message:readonly`.
- First-version extraction supports image OCR, PDF text layers, and UTF-8 text/Markdown/CSV/JSON/log files.
- Each resource is capped at 20 MiB and extracted output at 200,000 characters.
- Extracted entries retain the original message ID, so “别记这条”, raw retention, space export, and deletion cover them.
- macOS uses the built-in Vision/PDFKit frameworks; other platforms still ingest supported UTF-8 text files and skip image/PDF extraction safely.
- Audio transcription, Office formats, video, and post-embedded resources remain outside this first slice.
```

- [x] **Step 2: Run the focused feature suite**

```bash
bun test packages/connectors/src/feishu-normalize.test.ts packages/connectors/src/feishu.test.ts packages/orchestrator/src/attachment-extractor.test.ts packages/orchestrator/src/runtime.test.ts packages/core/src/governance.test.ts
bun run typecheck
xcrun swiftc -typecheck packages/orchestrator/src/attachment-extract.swift
```

Expected: all focused tests and both typecheckers pass.

- [x] **Step 3: Run the full suite once**

```bash
bun test
bun run typecheck
```

Expected: all non-live tests pass; live tests remain opt-in/skipped without `HOMEBRAIN_LIVE=1`.

- [x] **Step 4: Review and commit documentation**

Run the repository's two-axis code review against the commit before this plan, fix findings, then commit:

```bash
git add README.md docs/superpowers/plans/2026-07-14-multimodal-attachments.md
git commit -m "docs: describe multimodal attachment ingestion"
```

- [x] **Step 5: Restart and smoke-test production**

After graceful restart, verify `/healthz` and `/readyz` return 200. Send a disposable `.txt`, image, and text-layer PDF to a test Feishu space; run one dream cycle; verify each extracted fact appears in exported raw data and a generated knowledge page. Finally reply to one attachment message with `@机器人 别记这条` and verify all raw entries sharing that `messageId` are removed.

## Self-review

- Spec coverage: downloader, bounded extraction, raw ingestion, provenance/retraction/retention/export behavior, documentation, and production smoke tests each have an explicit task.
- Placeholder scan: this plan contains no implementation placeholders; deferred formats are declared as out of scope for the first slice.
- Type consistency: `DownloadedAttachment`, `downloadAttachments`, `messageType`, and `extractAttachmentText` use the same signatures in contract, implementation, tests, and runtime wiring.
