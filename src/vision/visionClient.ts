/**
 * Vision Client
 *
 * Analyzes images via the Anthropic API (Sonnet) by default.
 * Optionally routes to a local OpenAI-compatible LLM (LM Studio) first
 * when VISION_BACKEND=local is set.
 *
 * Auth priority (default):
 *   1. Anthropic API key (ANTHROPIC_API_KEY env var)
 *
 * Auth priority when VISION_BACKEND=local:
 *   1. Local LLM via LM Studio OpenAI-compat API
 *   2. Anthropic API key — fallback if local fails
 *
 * Config env vars (all optional):
 *   VISION_BACKEND      "anthropic" (default) | "local" — set to "local" to try LM Studio first
 *   LOCAL_VISION_URL    Base URL for OpenAI-compat server  (default: http://localhost:1234)
 *   LOCAL_VISION_MODEL  Model identifier                   (default: gemma-4-e4b-it)
 */

import Anthropic from "@anthropic-ai/sdk";
import { trace } from "../utils/tracer.ts";

export type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/** Model used for Anthropic API fallback (must support vision). */
export const VISION_MODEL = "claude-sonnet-4-6";

/** Maximum image size accepted (Anthropic's documented limit is 20MB). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Timeout for vision analysis. */
const VISION_TIMEOUT_MS = 60_000;

/** LM Studio base URL — override with LOCAL_VISION_URL. */
const localVisionUrl = (): string =>
  (process.env.LOCAL_VISION_URL ?? "http://localhost:1234").replace(/\/$/, "");

/** Model identifier for LM Studio — override with LOCAL_VISION_MODEL. */
const localVisionModel = (): string =>
  process.env.LOCAL_VISION_MODEL ?? "gemma-4-e4b-it";

/**
 * Call a local OpenAI-compatible LLM (LM Studio) for vision analysis.
 * Sends the image as a base64 data URI in the image_url content block.
 */
async function analyzeImageWithLocalLLM(
  imageBuffer: Buffer,
  mediaType: SupportedMediaType,
  prompt: string,
  signal: AbortSignal
): Promise<string> {
  const dataUri = `data:${mediaType};base64,${imageBuffer.toString("base64")}`;
  const body = JSON.stringify({
    model: localVisionModel(),
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const res = await fetch(`${localVisionUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Local LLM vision error ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Local LLM returned empty vision response");
  return text;
}

/**
 * Call the Anthropic API for vision analysis (fallback when local LLM fails).
 * Requires ANTHROPIC_API_KEY to be set.
 */
async function analyzeImageWithAnthropic(
  imageBuffer: Buffer,
  mediaType: SupportedMediaType,
  prompt: string,
  signal: AbortSignal
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Vision fallback failed: ANTHROPIC_API_KEY is not set. " +
        "Set it in ~/.claude-relay/.env or start LM Studio for local vision."
    );
  }

  const client = new Anthropic({ apiKey });
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
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBuffer.toString("base64"),
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    },
    { signal }
  );

  return response.content.find((b) => b.type === "text")?.text ?? "";
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
 * Examples:
 *   "/new what's in this picture" → "what's in this picture"
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
 * Analyze multiple images in parallel.
 *
 * Each image is analyzed independently. A single image failure does NOT
 * abort the batch — its error is captured in the result and the others proceed.
 *
 * Results are returned in the same order as the input array.
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
 * Analyze an image — uses Anthropic API (Sonnet) by default.
 * Set VISION_BACKEND=local to try LM Studio first with Anthropic as fallback.
 *
 * Local LLM (LM Studio) — only when VISION_BACKEND=local:
 *   - No API key required; configured via LOCAL_VISION_URL + LOCAL_VISION_MODEL
 *   - Uses OpenAI-compatible /v1/chat/completions with base64 data URI
 *
 * Anthropic (default and fallback):
 *   - Requires ANTHROPIC_API_KEY in env
 *
 * @param imageBuffer  Raw image bytes downloaded from Telegram
 * @param userPrompt   Caption or question the user sent with the image
 * @returns            Vision analysis text
 * @throws             If image too large or both backends fail
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

  const prompt =
    sanitizeCaptionForVision(userPrompt) || "Describe this image in detail.";
  const mediaType = detectMediaType(imageBuffer);

  const start = Date.now();
  trace({
    event: "vision_start",
    imageSizeBytes: imageBuffer.length,
    model: VISION_MODEL,
    mediaType,
    promptLength: prompt.length,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    // ── 1. Optional: Try local LLM (LM Studio) when VISION_BACKEND=local ────
    if (process.env.VISION_BACKEND === "local") {
      try {
        const text = await analyzeImageWithLocalLLM(
          imageBuffer,
          mediaType,
          prompt,
          controller.signal
        );
        trace({
          event: "vision_complete",
          backend: "local",
          model: localVisionModel(),
          durationMs: Date.now() - start,
          responseLength: text.length,
        });
        return text;
      } catch (localErr) {
        trace({
          event: "vision_local_failed",
          error: localErr instanceof Error ? localErr.message : String(localErr),
          durationMs: Date.now() - start,
        });
        // Fall through to Anthropic
      }
    }

    // ── 2. Anthropic API (default) ───────────────────────────────────────────
    const text = await analyzeImageWithAnthropic(
      imageBuffer,
      mediaType,
      prompt,
      controller.signal
    );
    trace({
      event: "vision_complete",
      backend: "anthropic",
      model: VISION_MODEL,
      durationMs: Date.now() - start,
      responseLength: text.length,
    });
    return text;
  } catch (err) {
    trace({
      event: "vision_error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      mediaType,
      imageSizeBytes: imageBuffer.length,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
