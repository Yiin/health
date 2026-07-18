// Database schema for the health dashboard.
//
// Domain tables land here (or in modules re-exported from here) so that
// `npm run db:generate` picks them up.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const DOCUMENT_TYPES = [
  "lab_report",
  "medical_doc",
  "wearable_export",
  "fit_export",
  "apple_health_export",
  "takeout_archive",
  "image",
  "unknown",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// The ingestion state machine: uploaded → classifying → extracting →
// normalizing → done | failed | needs_review | ignored. The worker resumes
// from the persisted status on retry.
export const DOCUMENT_STATUSES = [
  "uploaded",
  "classifying",
  "extracting",
  "normalizing",
  "done",
  "failed",
  "needs_review",
  "ignored",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentStageError {
  stage: string;
  message: string;
  at?: string;
}

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sha256: text("sha256").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    s3Key: text("s3_key").notNull(),
    // Zip children point at their archive (Google Takeout etc.).
    parentDocumentId: uuid("parent_document_id").references(
      (): AnyPgColumn => documents.id,
    ),
    documentType: text("document_type")
      .$type<DocumentType>()
      .notNull()
      .default("unknown"),
    provider: text("provider"),
    documentDate: date("document_date", { mode: "string" }),
    classificationConfidence: numeric("classification_confidence", {
      mode: "number",
    }),
    aiSummary: text("ai_summary"),
    extractedText: text("extracted_text"),
    status: text("status")
      .$type<DocumentStatus>()
      .notNull()
      .default("uploaded"),
    stageError: jsonb("stage_error").$type<DocumentStageError>(),
    attempts: integer("attempts").notNull().default(0),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NOTE: extracted_tsv — a generated tsvector over extracted_text +
    // ai_summary with a GIN index — is created by raw SQL in the migration.
    // drizzle does not model generated columns, so it deliberately stays out
    // of this schema; query it with sql`` fragments (see
    // src/db/repos/documents.ts).
  },
  (table) => [
    check(
      "documents_document_type_check",
      sql`${table.documentType} in ('lab_report','medical_doc','wearable_export','fit_export','apple_health_export','takeout_archive','image','unknown')`,
    ),
    check(
      "documents_status_check",
      sql`${table.status} in ('uploaded','classifying','extracting','normalizing','done','failed','needs_review','ignored')`,
    ),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export const INSIGHT_KINDS = [
  "post_ingestion",
  "biomarker_trend",
  "anomaly",
] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

// A pointer from an insight to the data it was derived from, e.g.
// { kind: "document", id: "<uuid>" } or { kind: "biomarker", id: "glucose" }.
export interface InsightSourceRef {
  kind: string;
  id: string;
  note?: string;
}

// drizzle has no native daterange column; carried as its text form
// ('[2026-01-01,2026-02-01)').
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "daterange";
  },
});

export const aiInsights = pgTable(
  "ai_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    kind: text("kind").$type<InsightKind>().notNull(),
    title: text("title"),
    bodyMd: text("body_md").notNull(),
    window: daterange("window"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    sourceRefs: jsonb("source_refs")
      .$type<InsightSourceRef[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    check(
      "ai_insights_kind_check",
      sql`${table.kind} in ('post_ingestion','biomarker_trend','anomaly')`,
    ),
  ],
);

export type AiInsight = typeof aiInsights.$inferSelect;
export type NewAiInsight = typeof aiInsights.$inferInsert;
