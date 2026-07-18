// Vision extraction primitives for the ingestion worker (health-etv.11):
// rasterize scanned PDF pages to images and upload them for Kimi vision
// (ms:// references). The extraction flows that use these primitives live in
// worker/extract.ts — this module is the I/O layer.
//
// Rasterization shells out to poppler's pdfinfo + pdftoppm (apk poppler-utils
// in the worker image, ~5 MB) instead of rendering through pdfjs +
// @napi-rs/canvas: poppler is far slimmer than the skia-based canvas native
// module, adds no npm dependency, and its renderer is the reference
// implementation — it also copes with PDFs pdfjs chokes on, which is exactly
// the population that lands here. Page images are JPEG at 150 DPI: lab
// reports are text-dense but not fine print, and JPEG keeps a 20-page scan's
// total upload under ~10 MB (PNG would be several times that).
//
// Runs under plain node type stripping in the worker container: node builtins
// and extension-carrying relative imports only.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ChatCompletionContentPart } from "openai/resources/chat/completions/completions";

import { deleteFile, uploadImage } from "../src/lib/kimi/files.ts";

/** A scanned PDF with more pages than this halts in needs_review. */
export const MAX_VISION_PAGES = 20;

/** Rasterization resolution; enough for dense lab tables at A4. */
export const VISION_RASTER_DPI = 150;

const execFileAsync = promisify(execFile);

export type RasterizeResult =
  | { kind: "ok"; pages: Uint8Array[]; pageCount: number }
  | { kind: "too-many-pages"; pageCount: number }
  /** The PDF could not be read at all (corrupt, not really a PDF). */
  | { kind: "failed"; detail: string };

export type RasterizePdf = (bytes: Uint8Array) => Promise<RasterizeResult>;

/** Uploads one page image; resolves to its image_url URL (ms://<fileId>). */
export type UploadVisionImage = (
  bytes: Uint8Array,
  filename: string,
) => Promise<string>;

/** Best-effort cleanup of an uploaded page image; never throws. */
export type DeleteVisionImage = (url: string) => Promise<void>;

interface PopplerError extends Error {
  code?: number | string;
  stderr?: string;
}

async function runPoppler(
  binary: "pdfinfo" | "pdftoppm",
  args: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const popplerError = error as PopplerError;
    // ENOENT = poppler-utils missing from the image — a deployment bug, not a
    // document problem. Throw so the job fails loudly (and retries), instead
    // of parking every scanned document in needs_review.
    if (popplerError.code === "ENOENT") {
      throw new Error(
        `${binary} not found — poppler-utils is required for the vision path`,
      );
    }
    throw error;
  }
}

/** Total page count via pdfinfo; null when the PDF is unreadable. */
async function pdfPageCount(pdfPath: string): Promise<number | null> {
  let stdout: string;
  try {
    stdout = await runPoppler("pdfinfo", [pdfPath], 30_000);
  } catch (error) {
    if (error instanceof Error && error.message.includes("poppler-utils")) {
      throw error;
    }
    return null;
  }
  const match = /^Pages:\s+(\d+)$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * Rasterizes a scanned PDF to per-page JPEGs. Page count comes from pdfinfo
 * first so a >MAX_VISION_PAGES document is refused WITHOUT paying for the
 * render. A missing poppler binary throws (deployment bug); an unreadable or
 * corrupt PDF comes back as { kind: "failed" } for the caller to park in
 * needs_review.
 */
export const rasterizePdfPages: RasterizePdf = async (bytes) => {
  const dir = await mkdtemp(join(tmpdir(), "vision-raster-"));
  try {
    const pdfPath = join(dir, "scan.pdf");
    await writeFile(pdfPath, bytes);

    const pageCount = await pdfPageCount(pdfPath);
    if (pageCount === null) {
      return { kind: "failed", detail: "pdfinfo could not read the PDF" };
    }
    if (pageCount > MAX_VISION_PAGES) {
      return { kind: "too-many-pages", pageCount };
    }
    if (pageCount === 0) {
      return { kind: "failed", detail: "PDF has no pages" };
    }

    const prefix = join(dir, "page");
    try {
      await runPoppler(
        "pdftoppm",
        ["-jpeg", "-r", String(VISION_RASTER_DPI), pdfPath, prefix],
        120_000,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("poppler-utils")) {
        throw error;
      }
      const stderr = (error as PopplerError).stderr?.trim();
      return {
        kind: "failed",
        detail: `pdftoppm failed${stderr ? `: ${stderr.slice(0, 300)}` : ""}`,
      };
    }

    // pdftoppm names pages page-NN.jpg zero-padded to the page count's width;
    // sort numerically so page 2 never lands after page 10.
    const pageFiles = (await readdir(dir))
      .filter((name) => /^page-\d+\.jpg$/.test(name))
      .sort(
        (a, b) =>
          Number(/-(\d+)\.jpg$/.exec(a)![1]) - Number(/-(\d+)\.jpg$/.exec(b)![1]),
      );
    if (pageFiles.length === 0) {
      return { kind: "failed", detail: "pdftoppm produced no page images" };
    }
    const pages = await Promise.all(
      pageFiles.map(async (name) => {
        const buffer = await readFile(join(dir, name));
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
      }),
    );
    return { kind: "ok", pages, pageCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Default upload: Kimi Files API (purpose=image) → ms://<fileId> reference. */
export const uploadVisionImage: UploadVisionImage = async (bytes, filename) => {
  const ref = await uploadImage(bytes, filename);
  return `ms://${ref.fileId}`;
};

/**
 * Default cleanup: deletes the Kimi file behind an ms:// reference. Never
 * throws — a leaked file must not fail the stage (same precedent as the
 * classifier's file-extract cleanup).
 */
export const deleteVisionImage: DeleteVisionImage = async (url) => {
  if (!url.startsWith("ms://")) return;
  await deleteFile(url.slice("ms://".length)).catch(() => {
    // Best-effort cleanup; a leaked file never fails the stage.
  });
};

/**
 * Builds the user-message content for a vision extraction: one instruction
 * text part followed by every page image (ms:// reference), in page order.
 */
export function visionUserContent(
  text: string,
  imageUrls: string[],
): ChatCompletionContentPart[] {
  return [
    { type: "text", text },
    ...imageUrls.map(
      (url): ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url },
      }),
    ),
  ];
}

const IMAGE_FILENAME = /\.(jpe?g|png|webp|tiff?)$/i;

/** Image files go straight to vision; only PDFs need rasterization. */
export function isImageFilename(filename: string): boolean {
  return IMAGE_FILENAME.test(filename);
}
