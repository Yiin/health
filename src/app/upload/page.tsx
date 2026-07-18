import { Info } from "lucide-react";

import { UploadClient } from "@/components/upload/upload-client";

export default function UploadPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop lab PDFs, wearable CSVs, medical scans, Apple Health exports, or
          Google Takeout archives — no questions asked. The AI classifies,
          extracts, and files everything; watch it happen below.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-sky-400/20 bg-sky-400/5 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
        <p>
          Exporting from Google Takeout? Choose{" "}
          <span className="font-medium text-foreground">
            export parts of 2 GB or less
          </span>{" "}
          when Google asks — bigger files are rejected by the 2 GB per-file
          limit, and smaller parts upload more reliably.
        </p>
      </div>

      <UploadClient />
    </div>
  );
}
