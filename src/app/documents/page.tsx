import { db } from "@/db";
import {
  listDocuments,
  listDocumentProviders,
  searchDocuments,
  type DocumentListItem,
} from "@/db/repos/documents";
import { DOCUMENT_TYPES, type DocumentType } from "@/db/schema";
import { DocumentCard } from "@/components/documents/document-card";
import { DocumentSearchForm } from "@/components/documents/search-form";

// Reads the database per request; never prerendered at build time.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 60;

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = firstParam(params.q);
  const typeParam = firstParam(params.type);
  const type = (DOCUMENT_TYPES as readonly string[]).includes(typeParam)
    ? (typeParam as DocumentType)
    : undefined;
  const provider = firstParam(params.provider) || undefined;

  const [providers, items] = await Promise.all([
    listDocumentProviders(db),
    q
      ? searchDocuments(db, q, { type, provider, limit: PAGE_SIZE })
      : listDocuments(db, { type, provider, limit: PAGE_SIZE }),
  ]);
  const hits: (DocumentListItem & { snippet?: string })[] = items;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every uploaded file, searchable across AI summaries and extracted
          text.
        </p>
      </div>

      <DocumentSearchForm
        q={q}
        type={type}
        provider={provider}
        providers={providers}
      />

      <p className="text-xs text-muted-foreground">
        {q
          ? `${hits.length} result${hits.length === 1 ? "" : "s"} for “${q}”`
          : `${hits.length} document${hits.length === 1 ? "" : "s"}`}
      </p>

      {hits.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {q || type || provider
            ? "No documents match these filters."
            : "No documents yet — drop files on the Upload page to get started."}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {hits.map((item) => (
            <DocumentCard key={item.id} item={item} snippet={item.snippet} />
          ))}
        </div>
      )}
    </div>
  );
}
