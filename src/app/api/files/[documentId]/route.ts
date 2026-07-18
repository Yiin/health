import { Readable } from "node:stream";

import { findDocumentFile } from "@/lib/document-files";
import { getOriginalStream } from "@/lib/storage";

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Stream a document's original bytes from S3 through the app (v1 has no
 * presigned URLs — MinIO is unreachable from tailnet browsers). The body is
 * piped straight from the S3 response to the HTTP response, never buffered.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const doc = await findDocumentFile(documentId);
  if (!doc) {
    return Response.json({ error: "unknown document" }, { status: 404 });
  }
  const object = await getOriginalStream(doc.s3Key);
  if (!object) {
    return Response.json(
      { error: "original missing from storage" },
      { status: 404 },
    );
  }
  const headers = new Headers({
    "content-type":
      doc.contentType ?? object.contentType ?? "application/octet-stream",
    "content-disposition": contentDisposition(doc.filename),
  });
  if (object.contentLength !== undefined) {
    headers.set("content-length", String(object.contentLength));
  }
  return new Response(Readable.toWeb(object.body) as ReadableStream, {
    headers,
  });
}
