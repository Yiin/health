/**
 * Kimi Files API wrapper (server-only).
 *
 * Text-first extraction design: `uploadForExtract` + `getExtractedText` is the
 * primary path (free, byte-exact values from the text layer); `uploadImage`
 * produces `ms://<fileId>` vision references for scanned/image-only documents
 * and layout-complexity escalations. All calls are serialized and retried via
 * the shared queue/backoff in ./client.
 */

import { KimiError, kimiFetch, kimiQueue, withBackoff } from "./client.ts";

/** Kimi rejects files above 100 MB — enforced client-side. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Extensions Kimi's file-extract/vision pipeline accepts (lowercase, no dot). */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "csv",
  "txt",
  "md",
  "json",
  "jpeg",
  "jpg",
  "png",
  "webp",
  "tiff",
  "docx",
  "xlsx",
  "html",
]);

/** Result of reading a file-extract upload's parsed content. */
export type KimiExtractResult =
  | { kind: "text"; text: string }
  // Scanned PDFs can extract empty — callers fall back to vision.
  | { kind: "empty" };

/** Result of an image upload — reference via ms://<fileId> in vision messages. */
export type KimiImageRef = { kind: "image-ref"; fileId: string };

export type KimiFileResult = KimiExtractResult | KimiImageRef;

type FilePurpose = "file-extract" | "image";

/** Upload a document for server-side text extraction. */
export async function uploadForExtract(
  buffer: Uint8Array,
  filename: string,
): Promise<{ fileId: string }> {
  return uploadFile(buffer, filename, "file-extract");
}

/** Upload an image and get a reference for ms:// vision messages. */
export async function uploadImage(
  buffer: Uint8Array,
  filename: string,
): Promise<KimiImageRef> {
  const { fileId } = await uploadFile(buffer, filename, "image");
  return { kind: "image-ref", fileId };
}

/**
 * Moonshot rejects files whose text layer yields nothing (scanned/image-only
 * PDFs) with 400 "text extract error: 没有解析出内容" — for purpose=file-extract
 * that can happen at UPLOAD time (POST /files) as well as at content fetch.
 */
export function isNoTextLayerError(error: unknown): boolean {
  return (
    error instanceof KimiError &&
    error.kind === "api" &&
    error.status === 400 &&
    /text extract error/i.test(error.message)
  );
}

/** Fetch the text Kimi extracted from a file-extract upload. */
export async function getExtractedText(
  fileId: string,
): Promise<KimiExtractResult> {
  return kimiQueue(() =>
    withBackoff(async () => {
      let response: Response;
      try {
        response = await kimiFetch(
          `/files/${encodeURIComponent(fileId)}/content`,
        );
      } catch (error) {
        // No text layer (scanned PDF): treat exactly like an empty extraction
        // so callers take their fallback path (raw head sample / vision).
        if (isNoTextLayerError(error)) return { kind: "empty" };
        throw error;
      }
      const raw = await response.text();
      // file-extract content comes back as JSON with a `content` field, but be
      // lenient: a plain-text body is used as-is.
      let text = raw;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { content?: unknown }).content === "string"
        ) {
          text = (parsed as { content: string }).content;
        }
      } catch {
        // Plain-text body — use as-is.
      }
      return text.trim().length === 0
        ? { kind: "empty" }
        : { kind: "text", text };
    }),
  );
}

/** Delete an uploaded file. */
export async function deleteFile(fileId: string): Promise<void> {
  await kimiQueue(() =>
    withBackoff(async () => {
      await kimiFetch(`/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
      });
    }),
  );
}

async function uploadFile(
  buffer: Uint8Array,
  filename: string,
  purpose: FilePurpose,
): Promise<{ fileId: string }> {
  validateUpload(buffer, filename);
  return kimiQueue(() =>
    withBackoff(async () => {
      const form = new FormData();
      form.set("purpose", purpose);
      // Copy into a fresh ArrayBuffer-backed view to satisfy BlobPart typing.
      form.set("file", new Blob([new Uint8Array(buffer)]), filename);
      const response = await kimiFetch("/files", {
        method: "POST",
        body: form,
      });
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || body.id.length === 0) {
        throw new KimiError(
          "unknown",
          `Kimi file upload returned no file id (${filename})`,
        );
      }
      return { fileId: body.id };
    }),
  );
}

function validateUpload(buffer: Uint8Array, filename: string): void {
  const dotIndex = filename.lastIndexOf(".");
  const extension =
    dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new KimiError(
      "invalid-file",
      `Refusing to upload ${filename}: extension ".${extension}" is not allowed`,
    );
  }
  if (buffer.byteLength === 0) {
    throw new KimiError(
      "invalid-file",
      `Refusing to upload ${filename}: file is empty`,
    );
  }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new KimiError(
      "invalid-file",
      `Refusing to upload ${filename}: ${buffer.byteLength} bytes exceeds the 100 MB limit`,
    );
  }
}
