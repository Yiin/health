"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Reprocess action for done documents (detail page): POSTs to the reprocess
 * endpoint, which clears the cached stage output and re-runs the whole
 * ingestion pipeline — the recovery path for documents processed while a
 * stage was still a stub. The fresh run shows up on the /upload live feed.
 */
export function ReprocessButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reprocess() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/reprocess`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Reprocess failed (${response.status})`);
      }
      // Re-render the server page so the status badge tracks the new run.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reprocess failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => void reprocess()}
      >
        <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
        {pending ? "Reprocessing…" : "Reprocess"}
      </Button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
