import Link from "next/link";
import { FileText } from "lucide-react";

/** A quoted source passage the answer was built from; links to the document. */
export interface Citation {
  documentId: string;
  filename: string;
  quote: string;
}

export function CitationCard({ citation }: { citation: Citation }) {
  return (
    <Link
      href={`/documents/${citation.documentId}`}
      className="block rounded-md border border-border bg-muted/40 p-3 transition-colors hover:bg-muted"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FileText className="size-3 shrink-0" />
        <span className="truncate">{citation.filename}</span>
      </div>
      <blockquote className="mt-1 border-l-2 border-border pl-2 text-sm italic text-foreground/80">
        “{citation.quote}”
      </blockquote>
    </Link>
  );
}
