CREATE TABLE "ai_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"body_md" text NOT NULL,
	"window" daterange,
	"model" text,
	"prompt_version" text,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "ai_insights_kind_check" CHECK ("ai_insights"."kind" in ('post_ingestion','biomarker_trend','anomaly'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"s3_key" text NOT NULL,
	"parent_document_id" uuid,
	"document_type" text DEFAULT 'unknown' NOT NULL,
	"provider" text,
	"document_date" date,
	"classification_confidence" numeric,
	"ai_summary" text,
	"extracted_text" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"stage_error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "documents_document_type_check" CHECK ("documents"."document_type" in ('lab_report','medical_doc','wearable_export','fit_export','apple_health_export','takeout_archive','image','unknown')),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('uploaded','classifying','extracting','normalizing','done','failed','needs_review','ignored'))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_document_id_documents_id_fk" FOREIGN KEY ("parent_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Full-text search over everything extracted from or said about a document.
-- drizzle does not model generated columns, so extracted_tsv lives only here
-- (kept out of the TS schema on purpose; query it with sql`` fragments).
ALTER TABLE "documents" ADD COLUMN "extracted_tsv" tsvector
	GENERATED ALWAYS AS (
		to_tsvector('english', coalesce("extracted_text", '') || ' ' || coalesce("ai_summary", ''))
	) STORED;
--> statement-breakpoint
CREATE INDEX "documents_extracted_tsv_idx" ON "documents" USING GIN ("extracted_tsv");
--> statement-breakpoint
-- Link lab results back to the document they were extracted from. The
-- biomarker_results table is owned by a parallel task (labs domain) and may
-- not exist yet when this migration runs — add the FK only if it does. If the
-- labs migration lands after this one, it must add this FK itself.
DO $$
BEGIN
	IF to_regclass('public.biomarker_results') IS NOT NULL THEN
		ALTER TABLE "biomarker_results"
			ADD CONSTRAINT "biomarker_results_document_id_documents_id_fk"
			FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null;
	END IF;
END $$;