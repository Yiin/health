import Link from "next/link";

import type { DocumentListItem } from "@/db/repos/documents";
import { sanitizeHeadline } from "@/lib/headline";

import { EditedBadge, StatusBadge, TypeBadge } from "./badges";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function DocumentCard({
  item,
  snippet,
}: {
  item: DocumentListItem;
  /** ts_headline excerpt (search results only); sanitized before rendering. */
  snippet?: string;
}) {
  return (
    <Link
      href={`/documents/${item.id}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="min-w-0 truncate text-sm font-medium"
          title={item.filename}
        >
          {item.filename}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {item.edited && <EditedBadge />}
          <StatusBadge status={item.status} />
        </div>
      </div>

      {snippet ? (
        <p
          className="line-clamp-3 text-sm text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground"
          dangerouslySetInnerHTML={{ __html: sanitizeHeadline(snippet) }}
        />
      ) : item.summary ? (
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {item.summary}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <TypeBadge type={item.documentType} />
        {item.provider && <span>{item.provider}</span>}
        {item.documentDate && <span>{item.documentDate}</span>}
        <span className="ml-auto">uploaded {formatDate(item.uploadedAt)}</span>
      </div>
    </Link>
  );
}
