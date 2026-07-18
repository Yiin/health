"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DOCUMENT_TYPES, type DocumentType } from "@/db/schema";
import { Button } from "@/components/ui/button";

import { humanize } from "./badges";

const CONTROL_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-input/30 px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function EditMetadataForm({
  documentId,
  initial,
}: {
  documentId: string;
  initial: {
    documentType: DocumentType;
    provider: string | null;
    documentDate: string | null;
  };
}) {
  const router = useRouter();
  const [documentType, setDocumentType] = useState(initial.documentType);
  const [provider, setProvider] = useState(initial.provider ?? "");
  const [documentDate, setDocumentDate] = useState(initial.documentDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentType,
          provider: provider.trim() === "" ? null : provider.trim(),
          documentDate: documentDate === "" ? null : documentDate,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Save failed (${response.status})`);
      }
      setSaved(true);
      // Re-render the server page so badges/header reflect the overrides.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Type
          <select
            value={documentType}
            onChange={(event) =>
              setDocumentType(event.target.value as DocumentType)
            }
            className={CONTROL_CLASSES}
          >
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Provider
          <input
            type="text"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="e.g. UAB Hila"
            maxLength={200}
            className={CONTROL_CLASSES}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Document date
          <input
            type="date"
            value={documentDate}
            onChange={(event) => setDocumentDate(event.target.value)}
            className={CONTROL_CLASSES}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save metadata"}
        </Button>
        {saved && !error && (
          <span className="text-xs text-emerald-400">Saved</span>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Manual edits win over pipeline-extracted values and survive re-runs of
        the ingestion pipeline.
      </p>
    </form>
  );
}
