/**
 * Vision Client
 *
 * Analyzes images sent via Telegram using the Claude CLI (not the Anthropic SDK).
 * Downloads the image to /tmp, then calls:
 *   claude --dangerously-skip-permissions -p "<userPrompt>\n\nImage: <filename>" --cwd /tmp
 *
 * --dangerously-skip-permissions is required in -p (non-interactive) mode to allow
 * Claude CLI to read the image file without hanging on a permission prompt.
 * cwd=/tmp lets the relative filename resolve and prevents loading project CLAUDE.md files.
 * The temp file is deleted after analysis.
 *
 * This routes through the Claude Code CLI subscription — no separate API billing.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { claudeText } from "../claude-process.ts";

export type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/** Claude model used for vision analysis (must support vision; Haiku does not). */
export const VISION_MODEL = "claude-sonnet-4-6";

/** Maximum image size accepted (Anthropic's documented limit is 20MB). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Timeout for vision analysis — longer than the LTM default since image reads take time. */
const VISION_TIMEOUT_MS = 60_000;

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
 * a slash command. Passing the raw caption to Claude CLI in -p mode causes
 * the leading slash command to be interpreted as a Claude Code slash command
 * (e.g., /new resets the session), corrupting the vision analysis prompt.
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
 * Analyze multiple images in parallel using separate Claude CLI processes.
 *
 * Each image is analyzed in its own `claudeText` subprocess
 * (--dangerously-skip-permissions, cwd=/tmp). A single image failure does NOT
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
  return Promise.all(
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
 * Analyze an image using the Claude CLI's vision capabilities.
 *
 * Writes the image to /tmp, sets cwd=/tmp so Claude can read the file by
 * relative filename, then deletes the file when done.
 *
 * Returns a text description suitable for injection into agent prompts
 * via the `imageContext` field in PromptContext.
 *
 * @param imageBuffer  Raw image bytes downloaded from Telegram
 * @param userPrompt   Caption or question the user sent with the image
 * @returns            Vision analysis text
 * @throws             If image too large or Claude CLI call fails
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

  // Strip leading slash commands (e.g., /new, /help) so Claude CLI doesn't
  // misinterpret them as Claude Code slash commands during vision analysis.
  const sanitizedPrompt = sanitizeCaptionForVision(userPrompt) || "Describe this image in detail.";

  const mediaType = detectMediaType(imageBuffer);
  const ext = mediaType.split("/")[1]; // "jpeg", "png", "gif", "webp"
  const tmpPath = join(
    tmpdir(),
    `telegram_img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  );

  await Bun.write(tmpPath, imageBuffer);

  try {
    // --dangerously-skip-permissions is required in -p (non-interactive) mode:
    // without it, Claude CLI hangs waiting for an interactive permission prompt.
    // cwd=/tmp lets the relative filename resolve without embedding /tmp in the prompt.
    const fileName = basename(tmpPath);
    const prompt = `${sanitizedPrompt}\n\nImage: ${fileName}`;
    return await claudeText(prompt, {
      model: VISION_MODEL,
      timeoutMs: VISION_TIMEOUT_MS,
      dangerouslySkipPermissions: true,
      cwd: tmpdir(),
    });
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
