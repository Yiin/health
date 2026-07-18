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
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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

/**
 * Biomarker catalog: one row per tracked analyte (glucose, hemoglobin, ...).
 * Seeded from src/db/seed/biomarkers.ts (`npm run db:seed`); extraction maps
 * as-reported analyte names onto `slug`/`aliases` and normalizes values into
 * `canonicalUnit`.
 */
export const biomarkers = pgTable("biomarkers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // English + Lithuanian lab-report spellings, matched case-insensitively.
  aliases: text("aliases")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  category: text("category").notNull(),
  // UCUM unit string (e.g. "mmol/L"); every result's value_canonical is in
  // this unit.
  canonicalUnit: text("canonical_unit").notNull(),
  loincCode: text("loinc_code"),
  // g/mol, only where a mol<->mass conversion applies (e.g. glucose 180.156).
  molarMassGMol: numeric("molar_mass_g_mol", { mode: "number" }),
});

export type Biomarker = typeof biomarkers.$inferSelect;
export type NewBiomarker = typeof biomarkers.$inferInsert;

export const RESULT_FLAGS = ["low", "normal", "high"] as const;
export type ResultFlag = (typeof RESULT_FLAGS)[number];

/**
 * One measured biomarker value, as reported by a lab document.
 * `value`/`unit` keep the as-reported pair; `value_canonical` is the same
 * measurement expressed in biomarkers.canonical_unit (null when no conversion
 * path exists — never guessed). ref_low/ref_high are canonical too; ref_text
 * keeps the raw range string ("< 5.7") for display.
 */
export const biomarkerResults = pgTable(
  "biomarker_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    biomarkerId: uuid("biomarker_id")
      .notNull()
      .references(() => biomarkers.id, { onDelete: "cascade" }),
    measuredOn: date("measured_on", { mode: "string" }).notNull(),
    value: numeric("value", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    valueCanonical: numeric("value_canonical", { mode: "number" }),
    refLow: numeric("ref_low", { mode: "number" }),
    refHigh: numeric("ref_high", { mode: "number" }),
    refText: text("ref_text"),
    labName: text("lab_name"),
    flag: text("flag").$type<ResultFlag>(),
    // The lab document this result was extracted from, if any.
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("biomarker_results_biomarker_date_value_unique").on(
      table.biomarkerId,
      table.measuredOn,
      table.valueCanonical,
    ),
    index("biomarker_results_biomarker_date_idx").on(
      table.biomarkerId,
      table.measuredOn,
    ),
    check(
      "biomarker_results_flag_check",
      sql`flag in ('low', 'normal', 'high')`,
    ),
  ],
);

export type BiomarkerResult = typeof biomarkerResults.$inferSelect;
export type NewBiomarkerResult = typeof biomarkerResults.$inferInsert;
