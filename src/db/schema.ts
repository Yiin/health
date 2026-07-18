// Database schema for the health dashboard.
//
// Domain tables land here (or in modules re-exported from here) so that
// `npm run db:generate` picks them up.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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

// Partition of the state machine: non-terminal means a pipeline run is still
// in flight (the live feed keeps polling); terminal means it has ended.
export const NON_TERMINAL_STATUSES = [
  "uploaded",
  "classifying",
  "extracting",
  "normalizing",
] as const satisfies readonly DocumentStatus[];
export const TERMINAL_STATUSES = [
  "done",
  "failed",
  "needs_review",
  "ignored",
] as const satisfies readonly DocumentStatus[];

export function isNonTerminalStatus(status: DocumentStatus): boolean {
  return (NON_TERMINAL_STATUSES as readonly DocumentStatus[]).includes(status);
}

export interface DocumentStageError {
  stage: string;
  message: string;
  at?: string;
}

// User-supplied edits to pipeline-extracted metadata. Stored separately from
// the extracted columns so re-running the ingestion pipeline never clobbers
// a manual edit: the UI reads effective values via effectiveMetadata()
// (src/lib/document-metadata.ts), overrides first. A key explicitly set to
// null means "the user cleared this field" (distinct from key absent).
export interface DocumentMetadataOverrides {
  documentType?: DocumentType;
  provider?: string | null;
  documentDate?: string | null;
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
    metadataOverrides:
      jsonb("metadata_overrides").$type<DocumentMetadataOverrides>(),
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

/**
 * Per-stage cache of pipeline output: one row per (document, stage), written
 * by the ingestion worker as each stage completes. A retried/resumed job
 * reuses the cached payload instead of re-running the stage (stage impls may
 * be expensive LLM calls), which is also what makes a mid-stage crash safe.
 */
export const rawExtractions = pgTable(
  "raw_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("raw_extractions_document_stage_unique").on(
      table.documentId,
      table.stage,
    ),
  ],
);

export type RawExtraction = typeof rawExtractions.$inferSelect;
export type NewRawExtraction = typeof rawExtractions.$inferInsert;

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
 * User-supplied edits to a pipeline-extracted result. Stored separately from
 * the extracted columns so re-ingesting the source document never clobbers a
 * manual edit: the UI reads effective values via effectiveResult()
 * (src/lib/labs.ts), overrides first. Absent keys mean "not edited".
 */
export interface BiomarkerResultOverrides {
  /** As-reported numeric value. */
  value?: number;
  /** ISO date string, YYYY-MM-DD. */
  measuredOn?: string;
  /** As-reported unit string. */
  unit?: string;
}

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
    userOverrides: jsonb("user_overrides").$type<BiomarkerResultOverrides>(),
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

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** A source the assistant's answer was built from; rendered as a quote card. */
export interface ChatCitation {
  documentId: string;
  filename: string;
  quote: string;
}

/**
 * The tool-calling rounds of one assistant turn, persisted so the next turn
 * can replay the full assistant(tool_calls) → tool(result) exchange to Kimi
 * (thinking models reject multi-turn histories without it).
 */
export interface StoredToolRounds {
  rounds: Array<{
    reasoningContent?: string;
    calls: Array<{
      id: string;
      name: string;
      arguments: unknown;
      /** The tool result content returned to the model (size-capped). */
      result: string;
    }>;
  }>;
}

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New conversation"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    // Assistant rows only: the tool-calling rounds that produced the answer.
    toolCalls: jsonb("tool_calls").$type<StoredToolRounds>(),
    // Assistant rows only: sources quoted in the answer.
    citations: jsonb("citations").$type<ChatCitation[]>(),
    // Kimi thinking models require echoing reasoning_content back in
    // multi-turn histories, so it must be persisted per assistant message.
    reasoningContent: text("reasoning_content"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    check("messages_role_check", sql`${table.role} in ('user','assistant')`),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/**
 * One wearable/self-reported metric value for one day from one source
 * (LONG/TALL format). The tall shape is deliberate: new metrics need no
 * migration, and sleep stages are just metrics (sleep_deep_min etc.).
 * The composite PK makes a (day, metric, source) triple unique — re-imports
 * upsert the value (last write wins PER SOURCE; cross-source dedup is
 * deliberately out of scope, the UI picks a preferred source).
 * Metric names + canonical units: src/db/metric-names.ts.
 */
export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    metricOn: date("metric_on", { mode: "string" }).notNull(),
    metric: text("metric").notNull(),
    source: text("source").notNull(),
    value: numeric("value", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.metricOn, table.metric, table.source] }),
    index("daily_metrics_metric_on_idx").on(table.metricOn),
  ],
);

export type DailyMetric = typeof dailyMetrics.$inferSelect;
export type NewDailyMetric = typeof dailyMetrics.$inferInsert;

/**
 * One workout session from one source. Re-imports are deduped by the
 * (started_at, type, source) unique index. `raw` keeps the unparsed source
 * record for debugging/re-processing.
 */
export const workouts = pgTable(
  "workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    type: text("type").notNull(),
    durationS: integer("duration_s"),
    distanceM: numeric("distance_m", { mode: "number" }),
    calories: integer("calories"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    source: text("source").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("workouts_started_type_source_unique").on(
      table.startedAt,
      table.type,
      table.source,
    ),
  ],
);

export type Workout = typeof workouts.$inferSelect;
export type NewWorkout = typeof workouts.$inferInsert;
