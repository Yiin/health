import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { db } from "@/db";
import { getDocument, listDocumentBiomarkers } from "@/db/repos/documents";
import { effectiveMetadata } from "@/lib/document-metadata";
import {
  EditedBadge,
  FlagBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/documents/badges";
import { EditMetadataForm } from "@/components/documents/edit-metadata-form";
import { ReprocessButton } from "@/components/documents/reprocess-button";
import { buttonVariants } from "@/components/ui/button";

// Reads the database per request; never prerendered at build time.
export const dynamic = "force-dynamic";

const EXCERPT_LENGTH = 800;

function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes == null) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5 text-card-foreground">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ProvenanceRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-4">
      <dt className="w-36 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const document = await getDocument(db, id);
  if (!document) notFound();

  const metadata = effectiveMetadata(document);
  const biomarkers = await listDocumentBiomarkers(db, id);
  const extractedText = document.extractedText;
  const excerpt = extractedText ? extractedText.slice(0, EXCERPT_LENGTH) : null;
  const excerptTruncated =
    extractedText != null && extractedText.length > EXCERPT_LENGTH;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link
        href="/documents"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Documents
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold break-all tracking-tight">
          {document.originalFilename}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={document.status} />
          <TypeBadge type={metadata.documentType} />
          {metadata.edited && <EditedBadge />}
          {metadata.provider && (
            <span className="text-xs text-muted-foreground">
              {metadata.provider}
            </span>
          )}
          {metadata.documentDate && (
            <span className="text-xs text-muted-foreground">
              {metadata.documentDate}
            </span>
          )}
        </div>
      </div>

      {document.aiSummary && (
        <Section title="AI summary">
          <p className="text-sm whitespace-pre-line text-card-foreground/90">
            {document.aiSummary}
          </p>
        </Section>
      )}

      {biomarkers.length > 0 && (
        <Section title={`Extracted biomarkers (${biomarkers.length})`}>
          <ul className="divide-y divide-border">
            {biomarkers.map((biomarker) => (
              <li
                key={`${biomarker.slug}-${biomarker.measuredOn}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <Link
                  href={`/labs/${biomarker.slug}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {biomarker.name}
                </Link>
                <span className="text-muted-foreground">
                  {biomarker.measuredOn}
                </span>
                <span className="ml-auto tabular-nums">
                  {biomarker.value} {biomarker.unit}
                </span>
                {biomarker.flag && <FlagBadge flag={biomarker.flag} />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Metadata">
        <EditMetadataForm documentId={document.id} initial={metadata} />
      </Section>

      <Section title="Provenance">
        <dl className="divide-y divide-border">
          <ProvenanceRow label="Original filename">
            <span className="break-all">{document.originalFilename}</span>
          </ProvenanceRow>
          <ProvenanceRow label="Actions">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/files/${document.id}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Download className="size-3.5" />
                Original file
              </a>
              {document.status === "done" && (
                <ReprocessButton documentId={document.id} />
              )}
            </div>
          </ProvenanceRow>
          <ProvenanceRow label="Uploaded">
            {formatTimestamp(document.uploadedAt)}
          </ProvenanceRow>
          <ProvenanceRow label="Size">
            {formatBytes(document.sizeBytes)}
          </ProvenanceRow>
          <ProvenanceRow label="Content type">
            {document.contentType ?? "—"}
          </ProvenanceRow>
          <ProvenanceRow label="SHA-256">
            <span
              className="font-mono text-xs break-all"
              title={document.sha256}
            >
              {document.sha256}
            </span>
          </ProvenanceRow>
          {document.parentDocumentId && (
            <ProvenanceRow label="Extracted from">
              <Link
                href={`/documents/${document.parentDocumentId}`}
                className="underline-offset-4 hover:underline"
              >
                Parent archive
              </Link>
            </ProvenanceRow>
          )}
          {document.classificationConfidence != null && (
            <ProvenanceRow label="Classifier confidence">
              {(document.classificationConfidence * 100).toFixed(0)}%
            </ProvenanceRow>
          )}
          {document.stageError && (
            <ProvenanceRow label="Stage error">
              <span className="text-red-400">
                {document.stageError.stage}: {document.stageError.message}
              </span>
            </ProvenanceRow>
          )}
        </dl>
      </Section>

      {excerpt && (
        <Section title="Source excerpt">
          <blockquote className="border-l-2 border-border pl-3">
            <pre className="font-sans text-sm whitespace-pre-wrap text-muted-foreground">
              {excerpt}
              {excerptTruncated && "…"}
            </pre>
          </blockquote>
        </Section>
      )}
    </div>
  );
}
