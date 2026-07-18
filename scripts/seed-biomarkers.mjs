// Biomarker catalog seed runner (`npm run db:seed`).
//
// Upserts src/db/seed/biomarkers.ts into the biomarkers table on slug, so it
// is idempotent and safe to re-run as the catalog evolves. Every canonical
// unit is validated as UCUM before anything is inserted. Schema changes are
// owned by migrations, not by this script.
//
// Plain .mjs (like scripts/migrate.mjs) so tsc/Next ignore it; node loads the
// .ts catalog via type stripping (Node >= 22.6 with --experimental-strip-types,
// default-on from 22.18).

import postgres from "postgres";

import {
  BIOMARKER_SEED,
  validateBiomarkerCatalog,
} from "../src/db/seed/biomarkers.ts";

// Mirror drizzle-kit's convenience: pick up DATABASE_URL from .env when the
// shell did not provide one. Existing env vars win (loadEnvFile does not
// override).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, DATABASE_URL may come from the environment
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[seed] DATABASE_URL environment variable is not set");
  process.exit(1);
}

validateBiomarkerCatalog();

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.begin(async (tx) => {
    for (const b of BIOMARKER_SEED) {
      await tx`
        insert into biomarkers
          (slug, name, aliases, category, canonical_unit, loinc_code, molar_mass_g_mol)
        values (
          ${b.slug}, ${b.name}, ${b.aliases}, ${b.category},
          ${b.canonicalUnit}, ${b.loincCode ?? null}, ${b.molarMassGMol ?? null}
        )
        on conflict (slug) do update set
          name = excluded.name,
          aliases = excluded.aliases,
          category = excluded.category,
          canonical_unit = excluded.canonical_unit,
          loinc_code = excluded.loinc_code,
          molar_mass_g_mol = excluded.molar_mass_g_mol
      `;
    }
  });
  console.log(`[seed] upserted ${BIOMARKER_SEED.length} biomarkers`);
} catch (error) {
  console.error("[seed] failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
