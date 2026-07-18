import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import busboy from "busboy";

import {
  authenticationRequiredResponse,
  isRequestAuthorized,
} from "@/lib/basic-auth";
import {
  ALLOWED_UPLOAD_TYPES,
  contentTypeForFilename,
  discardStaged,
  formatBytes,
  makeStagingDir,
  maxUploadBytes,
  registerStagedUpload,
  removeStagingDir,
  stageFile,
} from "@/lib/uploads";

interface FileResult {
  filename: string;
  ok: boolean;
  status: number;
  documentId?: string;
  sha256?: string;
  sizeBytes?: number;
  duplicate?: boolean;
  jobId?: string | null;
  error?: string;
}

/**
 * Streams one multipart file part through staging, registration, and the
 * ingest enqueue, appending its outcome to `results`. Never throws: per-file
 * failures are reported in place so one bad file cannot sink the batch.
 */
async function processFile(
  stream: Readable,
  filename: string,
  stagingDir: string,
  results: FileResult[],
): Promise<void> {
  const name = filename || "(unnamed)";
  const fail = (status: number, error: string) => {
    results.push({ filename: name, ok: false, status, error });
  };

  const contentType = contentTypeForFilename(name);
  if (!contentType) {
    // Drain the part so the parser can move on to the next one.
    stream.resume();
    fail(
      415,
      `unsupported file type — allowed: ${Object.keys(ALLOWED_UPLOAD_TYPES)
        .map((ext) => ext.slice(1))
        .join(", ")}`,
    );
    return;
  }

  // busboy truncates the stream at limits.fileSize and signals via "limit".
  let oversized = false;
  stream.on("limit", () => {
    oversized = true;
  });

  try {
    const staged = await stageFile(stream, stagingDir);
    if (oversized) {
      await discardStaged(staged.tmpPath);
      fail(413, `exceeds the ${formatBytes(maxUploadBytes())} per-file limit`);
      return;
    }
    try {
      const { document, isDuplicate, jobId } = await registerStagedUpload(
        staged,
        { filename: name, contentType },
      );
      results.push({
        filename: name,
        ok: true,
        status: 200,
        documentId: document.id,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        duplicate: isDuplicate,
        jobId,
      });
    } finally {
      await discardStaged(staged.tmpPath);
    }
  } catch (error) {
    console.error(`[uploads] failed to process ${name}`, error);
    fail(500, "upload failed — please try again");
  }
}

/**
 * Drop-anything upload endpoint. Multipart parts are streamed (never
 * buffered): each file is staged to disk while its SHA-256 is computed,
 * stored at the content-addressed S3 key, registered as a document, and
 * enqueued for ingestion — the insert and the enqueue commit together.
 * Re-uploading identical bytes returns the existing document with
 * duplicate=true and enqueues nothing.
 *
 * Responds 200 with per-file outcomes when at least one file was accepted,
 * otherwise the first failure's status. 400 when the request is not
 * multipart or contains no files.
 *
 * Excluded from the proxy matcher (a matched proxy would buffer the request
 * body at 10MB, truncating multi-GB streams), so the basic-auth gate is
 * enforced here directly.
 */
export async function POST(request: Request) {
  if (!isRequestAuthorized(request)) {
    return authenticationRequiredResponse();
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (
    !/^multipart\/form-data;\s*boundary=/.test(contentType) ||
    !request.body
  ) {
    return Response.json(
      { error: "expected multipart/form-data file upload" },
      { status: 400 },
    );
  }

  const results: FileResult[] = [];
  const stagingDir = await makeStagingDir();
  try {
    const parser = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: maxUploadBytes() },
    });
    const pending: Promise<void>[] = [];
    parser.on("file", (_field, stream, info) => {
      pending.push(processFile(stream, info.filename, stagingDir, results));
    });
    const parsed = new Promise<void>((resolve, reject) => {
      parser.on("finish", resolve);
      parser.on("error", reject);
    });
    Readable.fromWeb(request.body as unknown as WebReadableStream).pipe(parser);
    await parsed;
    await Promise.all(pending);
  } catch (error) {
    console.error("[uploads] could not parse multipart body", error);
    return Response.json(
      { error: "could not parse multipart body" },
      { status: 400 },
    );
  } finally {
    await removeStagingDir(stagingDir);
  }

  if (results.length === 0) {
    return Response.json(
      { error: "no files found in the upload" },
      { status: 400 },
    );
  }
  const ok = results.some((result) => result.ok);
  return Response.json(
    { files: results },
    { status: ok ? 200 : (results[0]?.status ?? 400) },
  );
}
