CREATE TABLE "biomarker_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"biomarker_id" uuid NOT NULL,
	"measured_on" date NOT NULL,
	"value" numeric NOT NULL,
	"unit" text NOT NULL,
	"value_canonical" numeric,
	"ref_low" numeric,
	"ref_high" numeric,
	"ref_text" text,
	"lab_name" text,
	"flag" text,
	"document_id" uuid,
	CONSTRAINT "biomarker_results_flag_check" CHECK (flag in ('low', 'normal', 'high'))
);
--> statement-breakpoint
CREATE TABLE "biomarkers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text NOT NULL,
	"canonical_unit" text NOT NULL,
	"loinc_code" text,
	"molar_mass_g_mol" numeric,
	CONSTRAINT "biomarkers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "biomarker_results" ADD CONSTRAINT "biomarker_results_biomarker_id_biomarkers_id_fk" FOREIGN KEY ("biomarker_id") REFERENCES "public"."biomarkers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "biomarker_results_biomarker_date_value_unique" ON "biomarker_results" USING btree ("biomarker_id","measured_on","value_canonical");--> statement-breakpoint
CREATE INDEX "biomarker_results_biomarker_date_idx" ON "biomarker_results" USING btree ("biomarker_id","measured_on");--> statement-breakpoint
COMMENT ON COLUMN "biomarker_results"."document_id" IS 'FK to documents.id is added by the documents-data issue (health-etv.12); plain uuid until then.';
