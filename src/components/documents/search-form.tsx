import Link from "next/link";

import { DOCUMENT_TYPES } from "@/db/schema";
import { Button } from "@/components/ui/button";

import { humanize } from "./badges";

const CONTROL_CLASSES =
  "h-8 rounded-lg border border-input bg-input/30 px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Filter bar for /documents. A native GET form: submission navigates to
 * /documents?q=…&type=…&provider=… and the page re-renders server-side, so
 * the library works without client JS.
 */
export function DocumentSearchForm({
  q,
  type,
  provider,
  providers,
}: {
  q: string;
  type: string | undefined;
  provider: string | undefined;
  providers: string[];
}) {
  const filtered = q !== "" || type !== undefined || provider !== undefined;
  return (
    <form
      action="/documents"
      method="get"
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search summaries and extracted text…"
        aria-label="Search documents"
        className={`${CONTROL_CLASSES} min-w-56 flex-1`}
      />
      <select
        name="type"
        defaultValue={type ?? ""}
        aria-label="Filter by type"
        className={CONTROL_CLASSES}
      >
        <option value="">All types</option>
        {DOCUMENT_TYPES.map((documentType) => (
          <option key={documentType} value={documentType}>
            {humanize(documentType)}
          </option>
        ))}
      </select>
      <select
        name="provider"
        defaultValue={provider ?? ""}
        aria-label="Filter by provider"
        className={CONTROL_CLASSES}
      >
        <option value="">All providers</option>
        {providers.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm">
        Search
      </Button>
      {filtered && (
        <Link
          href="/documents"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Clear
        </Link>
      )}
    </form>
  );
}
