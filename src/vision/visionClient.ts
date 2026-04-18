/**
 * Vision Client
 *
 * Analyzes images sent via Telegram using the Anthropic Messages API directly.
 * Images are sent as base64-encoded content — no temp files, no CLI subprocess,
 * no --dangerously-skip-permissions.
 *
 * Auth priority:
 *   1. ANTHROPIC_API_KEY env var (sk-ant-api03-... key — billed separately)
 *   2. Claude Code OAuth token from macOS Keychain (reuses Claude Code subscription)
 */

import Anthropic from "@anthropic-ai/sdk";
import { trace } from "../utils/tracer.ts";

export type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/** Claude model used for vision analysis (must support vision; Haiku does not). */
export const VISION_MODEL = "claude-sonnet-4-6";

/** Maximum image size accepted (Anthropic's documented limit is 20MB). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Timeout for vision analysis. */
const VISION_TIMEOUT_MS = 60_000;

/** Timeout for macOS keychain read (prevents hanging on permission prompt). */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Resolve an authenticated Anthropic client.
 *
 * Priority:
 *   1. ANTHROPIC_API_KEY env var  → apiKey auth (x-api-key header)
 *   2. macOS Keychain entry "Claude Code-credentials" → OAuth bearer token
 *
 * Re-reads credentials on every call so rotated tokens are picked up automatically.
 * The keychain read adds ~5ms overhead — acceptable for vision (not a hot path).
 */
async function resolveAnthropicClient(): Promise<Anthropic> {
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // macOS only — Claude Code stores its OAuth token in Keychain
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  let raw: string;
  try {
    const { stdout } = await exec(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS }
    );
    raw = stdout.trim();
  } catch {
    throw new Error(
      "Vision auth failed: set ANTHROPIC_API_KEY in .env, or run `claude login` to refresh Claude Code credentials"
    );
  }

  let token: string | undefined;
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    token = data?.claudeAiOauth?.accessToken;
  } catch {
    throw new Error("Vision auth failed: Claude Code credentials are malformed");
  }

  if (!token) {
    throw new Error(
      "Vision auth failed: Claude Code OAuth token missing — run `claude login` to re-authenticate"
    );
  }

  return new Anthropic({ authToken: token });
}

/**
 * Detect image MIME type from magic bytes.
 * Telegram photos are always JPEG; documents may vary.
 */
export function detectMediaType(buffer: Buffer): SupportedMediaType {
  // JPEG: FF D8 FF (3 bytes)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 (4 bytes)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: 47 49 46 (3 bytes)
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  // WebP: RIFF????WEBP (12 bytes)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // Default: Telegram photos are always JPEG
  return "image/jpeg";
}

/**
 * Strip leading bot slash commands from a Telegram photo caption.
 *
 * When a user sends "/new what's in this picture", the caption begins with
 * a slash command. Passing the raw caption to the API may cause the leading
 * slash command to be misinterpreted.
 *
 * This function strips the leading command prefix, leaving only the user's
 * actual question for the vision model.
 *
 * Examples:
 *   "/new what's in this picture" → "what's in this picture"
 *   "/help describe this"         → "describe this"
 *   "/new"                        → "" (caller should use default prompt)
 *   "Describe this image"         → "Describe this image" (unchanged)
 */
export function sanitizeCaptionForVision(caption: string): string {
  return caption.replace(/^\/\w+\s*/, "").trim();
}

/** Single image analysis result from a batch call. */
export interface ImageAnalysisResult {
  /** Zero-based position in the input array — preserved even on error. */
  index: number;
  /** Vision analysis text. Empty string when `error` is set. */
  context: string;
  /** Populated when this image's analysis failed; others in the batch still succeed. */
  error?: string;
}

/**
 * Analyze multiple images in parallel using the Anthropic API.
 *
 * Each image is analyzed independently. A single image failure does NOT
 * abort the batch — its error is captured in the result and the others proceed.
 *
 * Results are returned in the same order as the input array.
 *
 * @param imageBuffers  Array of raw image bytes (one per image)
 * @param prompt        Caption or question applied to every image
 * @returns             Ordered array of analysis results
 */
export async function analyzeImages(
  imageBuffers: Buffer[],
  prompt: string = "Describe this image in detail."
): Promise<ImageAnalysisResult[]> {
  if (imageBuffers.length === 0) return [];

  const batchStart = Date.now();
  trace({ event: "vision_batch_start", imageCount: imageBuffers.length });

  const results = await Promise.all(
    imageBuffers.map(async (buffer, index) => {
      try {
        const context = await analyzeImage(buffer, prompt);
        return { index, context };
      } catch (err) {
        return {
          index,
          context: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const successCount = results.filter((r) => !r.error).length;
  const failCount = results.filter((r) => !!r.error).length;
  trace({
    event: "vision_batch_complete",
    imageCount: imageBuffers.length,
    successCount,
    failCount,
    durationMs: Date.now() - batchStart,
  });

  return results;
}

/**
 * Merge multiple image analysis results into a single `imageContext` string
 * ready for injection into the agent prompt.
 *
 * - Single image  → context returned as-is (no numbering prefix)
 * - Multiple images → "Image N:\n<context>" sections separated by blank lines
 * - Failures are described inline so the agent knows an image wasn't available
 *
 * @param results  Output from `analyzeImages()`
 * @returns        Combined string suitable for the `imageContext` prompt field
 */
export function combineImageContexts(results: ImageAnalysisResult[]): string {
  if (results.length === 0) return "";
  if (results.length === 1) {
    const { context, error } = results[0];
    return error ? `[Image analysis failed: ${error}]` : context;
  }
  return results
    .map(({ index, context, error }) =>
      error
        ? `[Image ${index + 1}: analysis failed — ${error}]`
        : `Image ${index + 1}:\n${context}`
    )
    .join("\n\n");
}

/**
 * Analyze an image using the Anthropic Messages API (vision).
 *
 * The image is sent as base64-encoded content directly in the API request —
 * no temp files written, no CLI subprocess, no dangerouslySkipPermissions.
 *
 * Returns a text description suitable for injection into agent prompts
 * via the `imageContext` field in PromptContext.
 *
 * Emits trace events: vision_start, vision_complete (success), vision_error (failure).
 *
 * @param imageBuffer  Raw image bytes downloaded from Telegram
 * @param userPrompt   Caption or question the user sent with the image
 * @returns            Vision analysis text
 * @throws             If image too large or API call fails
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  userPrompt: string = "Describe this image in detail."
): Promise<string> {
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    const sizeMB = (imageBuffer.length / 1024 / 1024).toFixed(1);
    throw new Error(
      `Image too large: ${sizeMB}MB (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`
    );
  }

  const sanitizedPrompt =
    sanitizeCaptionForVision(userPrompt) || "Describe this image in detail.";

  const mediaType = detectMediaType(imageBuffer);
  const imageData = imageBuffer.toString("base64");

  const start = Date.now();
  trace({
    event: "vision_start",
    imageSizeBytes: imageBuffer.length,
    model: VISION_MODEL,
    mediaType,
    promptLength: sanitizedPrompt.length,
  });

  const client = await resolveAnthropicClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model: VISION_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageData },
              },
              { type: "text", text: sanitizedPrompt },
            ],
          },
        ],
      },
      { signal: controller.signal }
    );

    const text = response.content.find((b) => b.type === "text")?.text ?? "";

    trace({
      event: "vision_complete",
      durationMs: Date.now() - start,
      responseLength: text.length,
      model: VISION_MODEL,
      mediaType,
    });

    return text;
  } catch (err) {
    trace({
      event: "vision_error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      model: VISION_MODEL,
      mediaType,
      imageSizeBytes: imageBuffer.length,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
