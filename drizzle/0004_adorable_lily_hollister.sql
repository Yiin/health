CREATE TABLE "daily_metrics" (
	"metric_on" date NOT NULL,
	"metric" text NOT NULL,
	"source" text NOT NULL,
	"value" numeric NOT NULL,
	"unit" text NOT NULL,
	CONSTRAINT "daily_metrics_metric_on_metric_source_pk" PRIMARY KEY("metric_on","metric","source")
);
--> statement-breakpoint
CREATE TABLE "workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"type" text NOT NULL,
	"duration_s" integer,
	"distance_m" numeric,
	"calories" integer,
	"avg_hr" integer,
	"max_hr" integer,
	"source" text NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE INDEX "daily_metrics_metric_on_idx" ON "daily_metrics" USING btree ("metric_on");--> statement-breakpoint
CREATE UNIQUE INDEX "workouts_started_type_source_unique" ON "workouts" USING btree ("started_at","type","source");