// Database schema for the health dashboard.
//
// Domain tables land in their own tasks (labs, documents, activity). Table
// definitions go here (or in modules re-exported from here) so that
// `npm run db:generate` picks them up.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    // FK to documents.id is added by the documents-data issue (health-etv.12);
    // a plain uuid column until then. Mirrored as a SQL column comment.
    documentId: uuid("document_id"),
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
