"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { ALLOWED_UPLOAD_TYPES } from "@/lib/upload-types";

const ACCEPT = Object.keys(ALLOWED_UPLOAD_TYPES).join(",");
const KINDS = Object.keys(ALLOWED_UPLOAD_TYPES)
  .map((ext) => ext.slice(1))
  .join(", ");

/**
 * The one drop-anything dropzone: drag-drop or click to browse. No type
 * questions — classification is the pipeline's job; the extension allowlist
 * only mirrors what POST /api/uploads accepts (2 GB per file).
 */
export function Dropzone({
  onFiles,
}: {
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    onFiles([...files]);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Drop files to upload, or press to browse"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        pick(event.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
        dragActive
          ? "border-sky-400 bg-sky-400/10"
          : "border-border bg-card hover:border-muted-foreground/50 hover:bg-muted/40",
      )}
    >
      <Upload
        className={cn(
          "size-8",
          dragActive ? "text-sky-400" : "text-muted-foreground",
        )}
      />
      <p className="text-sm font-medium">
        {dragActive ? "Drop to upload" : "Drop files here, or click to browse"}
      </p>
      <p className="text-xs text-muted-foreground">
        {KINDS} — up to 2 GB each. The AI classifies and extracts everything.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          pick(event.target.files);
          // Allow picking the same file again.
          event.target.value = "";
        }}
      />
    </div>
  );
}
