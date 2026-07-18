"use client";

import { useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import {
  ALLOWED_UPLOAD_TYPES,
  contentTypeForFilename,
} from "@/lib/upload-types";
import { Button } from "@/components/ui/button";

import { Dropzone } from "./dropzone";
import { FeedCard } from "./feed-card";
import { useIngestionFeed } from "./use-ingestion-feed";

// Mirrors POST /api/uploads's per-file outcome.
interface UploadFileResult {
  filename: string;
  ok: boolean;
  status: number;
  documentId?: string;
  duplicate?: boolean;
  error?: string;
}

interface UploadEntry {
  key: string;
  file: File;
  /** 0..1 while uploading. */
  progress: number;
  state: "uploading" | "duplicate" | "error";
  documentId?: string;
  error?: string;
}

const SUPPORTED = Object.keys(ALLOWED_UPLOAD_TYPES)
  .map((ext) => ext.slice(1))
  .join(", ");

/**
 * One XHR per file: fetch cannot report upload progress, and one request per
 * file makes per-file progress and per-file errors trivial. Never rejects —
 * failures come back as `{ error }` so one bad file cannot sink the batch.
 */
function uploadFile(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ result?: UploadFileResult; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { files?: UploadFileResult[] } | null;
      const result = body?.files?.[0];
      if (xhr.status === 200 && result?.ok) {
        resolve({ result });
      } else {
        resolve({
          error: result?.error ?? `upload failed (${xhr.status})`,
        });
      }
    };
    xhr.onerror = () => resolve({ error: "network error — upload failed" });
    xhr.ontimeout = () => resolve({ error: "upload timed out" });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/**
 * /upload: the dropzone, in-flight upload rows with progress, and the live
 * ingestion feed underneath — a dropped file moves from "uploading" into the
 * feed and through the pipeline stages with no page refresh.
 */
export function UploadClient() {
  const feed = useIngestionFeed();
  const [entries, setEntries] = useState<UploadEntry[]>([]);

  function patchEntry(key: string, patch: Partial<UploadEntry>) {
    setEntries((previous) =>
      previous.map((entry) =>
        entry.key === key ? { ...entry, ...patch } : entry,
      ),
    );
  }

  function handleFiles(files: File[]) {
    for (const file of files) {
      const key = crypto.randomUUID();
      if (!contentTypeForFilename(file.name)) {
        setEntries((previous) => [
          ...previous,
          {
            key,
            file,
            progress: 0,
            state: "error",
            error: `unsupported file type — allowed: ${SUPPORTED}`,
          },
        ]);
        continue;
      }
      setEntries((previous) => [
        ...previous,
        { key, file, progress: 0, state: "uploading" },
      ]);
      void uploadOne(key, file);
    }
  }

  async function uploadOne(key: string, file: File) {
    const { result, error } = await uploadFile(file, (loaded, total) => {
      patchEntry(key, { progress: total > 0 ? loaded / total : 0 });
    });
    if (error) {
      patchEntry(key, { state: "error", error });
      return;
    }
    if (result?.duplicate) {
      // The document already exists (possibly outside the feed's recent
      // window), so keep a row linking to it instead of handing off.
      patchEntry(key, { state: "duplicate", documentId: result.documentId });
      return;
    }
    // Fresh document: hand the row off to the live feed below.
    setEntries((previous) => previous.filter((entry) => entry.key !== key));
    feed.refresh();
  }

  function dismiss(key: string) {
    setEntries((previous) => previous.filter((entry) => entry.key !== key));
  }

  return (
    <div className="flex flex-col gap-6">
      <Dropzone onFiles={handleFiles} />

      {entries.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Uploads">
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm">{entry.file.name}</span>
                {entry.state === "uploading" && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {Math.round(entry.progress * 100)}%
                  </span>
                )}
                {entry.state !== "uploading" && (
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => dismiss(entry.key)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              {entry.state === "uploading" && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width]"
                    style={{ width: `${Math.round(entry.progress * 100)}%` }}
                  />
                </div>
              )}
              {entry.state === "duplicate" && (
                <p className="text-xs text-muted-foreground">
                  Already uploaded —{" "}
                  <Link
                    href={`/documents/${entry.documentId}`}
                    className="text-sky-400 hover:underline"
                  >
                    view the existing document
                  </Link>
                  .
                </p>
              )}
              {entry.state === "error" && (
                <p className="text-xs text-red-400">{entry.error}</p>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label="Ingestion status">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">
            Ingestion status
          </h2>
          {feed.hasActive && (
            <span className="text-xs text-muted-foreground">
              updating every 3 s
            </span>
          )}
        </div>
        {feed.error && (
          <p className="text-xs text-red-400">
            {feed.error}{" "}
            <Button variant="link" size="sm" onClick={feed.refresh}>
              try again
            </Button>
          </p>
        )}
        {feed.loaded && feed.documents.length === 0 && !feed.error ? (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            Nothing processing right now — dropped files will show up here as
            they move through the pipeline.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {feed.documents.map((doc) => (
              <FeedCard key={doc.id} doc={doc} onAction={feed.refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
