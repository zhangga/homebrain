export interface LlmTextClient {
  generateText(input: { system: string; user: string }): Promise<string>;
}

export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface LlmVisionClient {
  generateTextFromImage(input: {
    system: string;
    prompt: string;
    image: { mediaType: LlmImageMediaType; dataBase64: string };
  }): Promise<string>;
}
