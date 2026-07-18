// Upload allowlist, shared between the server upload pipeline
// (src/lib/uploads.ts) and the browser dropzone — this module must stay free
// of server-only imports (db, storage, queue) so client components can use it.

// Allowlist keyed by extension (client-sent MIME types are untrustworthy):
// lab PDFs, wearable CSVs, Apple Health export.xml, Takeout/Fit zips, medical
// document images, plain text/json.
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".json": "application/json",
};

/** Canonical content type for an allowed filename, or null when rejected. */
export function contentTypeForFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return ALLOWED_UPLOAD_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}
