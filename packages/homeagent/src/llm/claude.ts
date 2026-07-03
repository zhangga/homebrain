import type { LlmTextClient, LlmVisionClient } from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClaudeClientOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  anthropicVersion?: string;
  fetch?: FetchLike;
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

export function createClaudeClient(opts: ClaudeClientOptions): LlmTextClient & LlmVisionClient {
  const doFetch: FetchLike = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  const maxTokens = opts.maxTokens ?? 1024;
  const anthropicVersion = opts.anthropicVersion ?? "2023-06-01";

  return {
    async generateText({ system, user }) {
      return sendClaudeMessage({
        doFetch,
        apiKey: opts.apiKey,
        anthropicVersion,
        model,
        maxTokens,
        system,
        content: user,
      });
    },
    async generateTextFromImage({ system, prompt, image }) {
      return sendClaudeMessage({
        doFetch,
        apiKey: opts.apiKey,
        anthropicVersion,
        model,
        maxTokens,
        system,
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.dataBase64,
            },
          },
          { type: "text", text: prompt },
        ],
      });
    },
  };
}

async function sendClaudeMessage(input: {
  doFetch: FetchLike;
  apiKey: string;
  anthropicVersion: string;
  model: string;
  maxTokens: number;
  system: string;
  content: string | ClaudeContentBlock[];
}): Promise<string> {
  const response = await input.doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": input.anthropicVersion,
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.content }],
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Claude 请求失败 (HTTP ${response.status}): ${bodyText.slice(0, 500)}`);
  }

  const data = JSON.parse(bodyText) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return (data.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
