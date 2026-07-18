// Biomarker seed catalog: ~40 common lab analytes with English + Lithuanian
// lab-report spellings. Kept as a typed array literal (not JSON) so it is
// typechecked; it is also dependency-light (only the UCUM validator import)
// so `scripts/seed-biomarkers.ts` can load it under node --experimental-strip-types.
//
// canonical_unit is a UCUM code; molar_mass_g_mol is set only where a
// mol<->mass conversion applies (see src/lib/units.ts). Aliases are matched
// case-insensitively, so they are stored lowercase.

import { UcumLhcUtils } from "@lhncbc/ucum-lhc";

export const BIOMARKER_CATEGORIES = [
  "cbc",
  "metabolic",
  "lipids",
  "thyroid",
  "vitamins",
  "minerals",
  "inflammation",
  "hormones",
] as const;

export type BiomarkerCategory = (typeof BIOMARKER_CATEGORIES)[number];

export interface BiomarkerSeed {
  slug: string;
  name: string;
  aliases: string[];
  category: BiomarkerCategory;
  canonicalUnit: string;
  loincCode?: string;
  molarMassGMol?: number;
}

export const BIOMARKER_SEED: BiomarkerSeed[] = [
  // --- CBC (complete blood count) ---
  {
    slug: "wbc",
    name: "White blood cells",
    aliases: ["wbc", "leukocytes", "white blood cells", "white blood cell count", "leu", "leukocitai", "baltieji kraujo kūneliai"],
    category: "cbc",
    canonicalUnit: "10*9/L",
    loincCode: "6690-2",
  },
  {
    slug: "rbc",
    name: "Red blood cells",
    aliases: ["rbc", "erythrocytes", "red blood cells", "red blood cell count", "eri", "eritrocitai", "raudonieji kraujo kūneliai"],
    category: "cbc",
    canonicalUnit: "10*12/L",
    loincCode: "789-8",
  },
  {
    slug: "hemoglobin",
    name: "Hemoglobin",
    aliases: ["hemoglobin", "hgb", "hb", "hemoglobinas"],
    category: "cbc",
    canonicalUnit: "g/dL",
    loincCode: "718-7",
  },
  {
    slug: "hematocrit",
    name: "Hematocrit",
    aliases: ["hematocrit", "hct", "pcv", "hematokritas"],
    category: "cbc",
    canonicalUnit: "%",
    loincCode: "4544-3",
  },
  {
    slug: "mcv",
    name: "Mean corpuscular volume",
    aliases: ["mcv", "mean corpuscular volume", "vidutinis eritrocito tūris"],
    category: "cbc",
    canonicalUnit: "fL",
    loincCode: "787-2",
  },
  {
    slug: "platelets",
    name: "Platelets",
    aliases: ["platelets", "plt", "thrombocytes", "platelet count", "trombocitai", "kraujo plokštelės"],
    category: "cbc",
    canonicalUnit: "10*9/L",
    loincCode: "777-3",
  },
  {
    slug: "mch",
    name: "Mean corpuscular hemoglobin",
    aliases: ["mch", "mean corpuscular hemoglobin", "vidutinis eritrocito hemoglobino kiekis"],
    category: "cbc",
    canonicalUnit: "pg",
    loincCode: "785-6",
  },
  {
    slug: "mchc",
    name: "Mean corpuscular hemoglobin concentration",
    aliases: ["mchc", "mean corpuscular hemoglobin concentration", "vidutinė hemoglobino koncentracija eritrocituose"],
    category: "cbc",
    canonicalUnit: "g/dL",
    loincCode: "786-4",
  },
  {
    slug: "rdw",
    name: "Red cell distribution width",
    aliases: ["rdw", "red cell distribution width", "eritrocitų pasiskirstymo plotis"],
    category: "cbc",
    canonicalUnit: "%",
    loincCode: "788-0",
  },

  // --- Metabolic ---
  {
    slug: "glucose",
    name: "Glucose",
    aliases: ["glucose", "glu", "fasting glucose", "blood sugar", "gliukozė", "gliukozė kraujyje"],
    category: "metabolic",
    canonicalUnit: "mmol/L",
    loincCode: "2345-7",
    molarMassGMol: 180.156,
  },
  {
    slug: "hba1c",
    name: "Hemoglobin A1c",
    aliases: ["hba1c", "hemoglobin a1c", "glycated hemoglobin", "glycated haemoglobin", "a1c", "glikuotasis hemoglobinas", "glikuotas hemoglobinas"],
    category: "metabolic",
    canonicalUnit: "%",
    loincCode: "4548-4",
  },
  {
    slug: "creatinine",
    name: "Creatinine",
    aliases: ["creatinine", "crea", "kreatininas"],
    category: "metabolic",
    canonicalUnit: "umol/L",
    loincCode: "2160-0",
    molarMassGMol: 113.12,
  },
  {
    slug: "egfr",
    name: "Estimated glomerular filtration rate",
    aliases: ["egfr", "estimated gfr", "gfr", "glomerular filtration rate", "glomerulų filtracijos greitis", "įvertintasis glomerulų filtracijos greitis"],
    category: "metabolic",
    canonicalUnit: "mL/min/{1.73_m2}",
    loincCode: "62238-1",
  },
  {
    slug: "bun",
    name: "Blood urea nitrogen / Urea",
    aliases: ["bun", "blood urea nitrogen", "urea", "šlapalas", "karbamidas", "kraujo šlapalo azotas"],
    category: "metabolic",
    canonicalUnit: "mmol/L",
    loincCode: "3094-0",
    molarMassGMol: 60.06,
  },
  {
    slug: "alt",
    name: "Alanine aminotransferase",
    aliases: ["alt", "alanine aminotransferase", "alat", "sgpt", "alanino aminotransferazė", "alanin aminotransferazė"],
    category: "metabolic",
    canonicalUnit: "U/L",
    loincCode: "1742-6",
  },
  {
    slug: "ast",
    name: "Aspartate aminotransferase",
    aliases: ["ast", "aspartate aminotransferase", "asat", "sgot", "aspartato aminotransferazė", "aspartat aminotransferazė"],
    category: "metabolic",
    canonicalUnit: "U/L",
    loincCode: "1920-8",
  },
  {
    slug: "alp",
    name: "Alkaline phosphatase",
    aliases: ["alp", "alkaline phosphatase", "šarminė fosfatazė"],
    category: "metabolic",
    canonicalUnit: "U/L",
    loincCode: "6768-6",
  },
  {
    slug: "bilirubin",
    name: "Total bilirubin",
    aliases: ["bilirubin", "total bilirubin", "t-bil", "tbil", "bilirubinas", "bendrasis bilirubinas"],
    category: "metabolic",
    canonicalUnit: "umol/L",
    loincCode: "1975-2",
    molarMassGMol: 584.66,
  },
  {
    slug: "albumin",
    name: "Albumin",
    aliases: ["albumin", "alb", "albuminas"],
    category: "metabolic",
    canonicalUnit: "g/L",
    loincCode: "1751-7",
  },
  {
    slug: "uric-acid",
    name: "Uric acid",
    aliases: ["uric acid", "urate", "uric", "šlapimo rūgštis"],
    category: "metabolic",
    canonicalUnit: "umol/L",
    loincCode: "3084-1",
    molarMassGMol: 168.11,
  },
  {
    slug: "total-protein",
    name: "Total protein",
    aliases: ["total protein", "protein total", "tp", "bendrasis baltymas", "bendrasis baltymų kiekis", "baltymai"],
    category: "metabolic",
    canonicalUnit: "g/L",
    loincCode: "2885-2",
  },

  // --- Lipids ---
  {
    slug: "total-cholesterol",
    name: "Total cholesterol",
    aliases: ["total cholesterol", "cholesterol", "chol", "tc", "cholesterinas", "bendrasis cholesterinas"],
    category: "lipids",
    canonicalUnit: "mmol/L",
    loincCode: "2093-3",
    molarMassGMol: 386.654,
  },
  {
    slug: "ldl",
    name: "LDL cholesterol",
    aliases: ["ldl", "ldl cholesterol", "ldl-c", "low-density lipoprotein", "low density lipoprotein cholesterol", "mažo tankio lipoproteinų cholesterinas", "mtl cholesterinas", "mtl-ch"],
    category: "lipids",
    canonicalUnit: "mmol/L",
    loincCode: "13457-7",
    molarMassGMol: 386.654,
  },
  {
    slug: "hdl",
    name: "HDL cholesterol",
    aliases: ["hdl", "hdl cholesterol", "hdl-c", "high-density lipoprotein", "high density lipoprotein cholesterol", "didelio tankio lipoproteinų cholesterinas", "dtl cholesterinas", "dtl-ch"],
    category: "lipids",
    canonicalUnit: "mmol/L",
    loincCode: "2085-9",
    molarMassGMol: 386.654,
  },
  {
    slug: "triglycerides",
    name: "Triglycerides",
    aliases: ["triglycerides", "tg", "trig", "trigliceridai"],
    category: "lipids",
    canonicalUnit: "mmol/L",
    loincCode: "2571-8",
    molarMassGMol: 885.7,
  },

  // --- Thyroid ---
  {
    slug: "tsh",
    name: "Thyroid-stimulating hormone",
    aliases: ["tsh", "thyroid stimulating hormone", "thyrotropin", "tth", "tirotropinas", "skydliaukę stimuliuojantis hormonas"],
    category: "thyroid",
    canonicalUnit: "m[IU]/L",
    loincCode: "3016-3",
  },
  {
    slug: "ft4",
    name: "Free thyroxine",
    aliases: ["ft4", "free t4", "free thyroxine", "laisvasis tiroksinas", "t4 laisvasis"],
    category: "thyroid",
    canonicalUnit: "pmol/L",
    loincCode: "3024-0",
    molarMassGMol: 776.87,
  },
  {
    slug: "ft3",
    name: "Free triiodothyronine",
    aliases: ["ft3", "free t3", "free triiodothyronine", "laisvasis trijodtironinas", "t3 laisvasis"],
    category: "thyroid",
    canonicalUnit: "pmol/L",
    loincCode: "3053-6",
    molarMassGMol: 650.97,
  },

  // --- Vitamins ---
  {
    slug: "vitamin-d-25oh",
    name: "Vitamin D (25-OH)",
    aliases: ["vitamin d", "25-oh vitamin d", "25-hydroxyvitamin d", "25(oh)d", "calcidiol", "vitaminas d", "vitamino d", "25-hidroksivitaminas d"],
    category: "vitamins",
    canonicalUnit: "nmol/L",
    loincCode: "1989-3",
    molarMassGMol: 384.64,
  },
  {
    slug: "b12",
    name: "Vitamin B12",
    aliases: ["vitamin b12", "b12", "cobalamin", "vitaminas b12", "kobalaminas", "cianokobalaminas"],
    category: "vitamins",
    canonicalUnit: "pmol/L",
    loincCode: "2132-9",
    molarMassGMol: 1355.37,
  },
  {
    slug: "ferritin",
    name: "Ferritin",
    aliases: ["ferritin", "fer", "feritinas"],
    category: "vitamins",
    canonicalUnit: "ug/L",
    loincCode: "2276-4",
  },
  {
    slug: "iron",
    name: "Iron",
    aliases: ["iron", "serum iron", "fe", "geležis", "serumo geležis"],
    category: "vitamins",
    canonicalUnit: "umol/L",
    loincCode: "2498-4",
    molarMassGMol: 55.845,
  },

  // --- Minerals ---
  {
    slug: "magnesium",
    name: "Magnesium",
    aliases: ["magnesium", "mg", "magnis"],
    category: "minerals",
    canonicalUnit: "mmol/L",
    loincCode: "19123-9",
    molarMassGMol: 24.305,
  },
  {
    slug: "calcium",
    name: "Calcium",
    aliases: ["calcium", "ca", "total calcium", "kalcis"],
    category: "minerals",
    canonicalUnit: "mmol/L",
    loincCode: "17861-6",
    molarMassGMol: 40.078,
  },
  {
    slug: "potassium",
    name: "Potassium",
    aliases: ["potassium", "k", "kalis"],
    category: "minerals",
    canonicalUnit: "mmol/L",
    loincCode: "2823-3",
  },
  {
    slug: "sodium",
    name: "Sodium",
    aliases: ["sodium", "na", "natris"],
    category: "minerals",
    canonicalUnit: "mmol/L",
    loincCode: "2951-2",
  },
  {
    slug: "phosphate",
    name: "Phosphate (inorganic)",
    aliases: ["phosphate", "inorganic phosphate", "phosphorus", "phos", "fosfatas", "neorganinis fosfatas", "fosforas"],
    category: "minerals",
    canonicalUnit: "mmol/L",
    loincCode: "14879-1",
  },

  // --- Inflammation ---
  {
    slug: "crp",
    name: "C-reactive protein",
    aliases: ["crp", "c-reactive protein", "c reactive protein", "crb", "c reaktyvusis baltymas", "c-reaktyvusis baltymas"],
    category: "inflammation",
    canonicalUnit: "mg/L",
    loincCode: "1988-5",
  },
  {
    slug: "hs-crp",
    name: "High-sensitivity C-reactive protein",
    aliases: ["hs-crp", "hscrp", "hs crp", "high sensitivity c-reactive protein", "high-sensitivity crp", "itin jautrus c reaktyvusis baltymas", "jautrusis c reaktyvusis baltymas"],
    category: "inflammation",
    canonicalUnit: "mg/L",
    loincCode: "30522-7",
  },

  // --- Hormones ---
  {
    slug: "testosterone",
    name: "Testosterone",
    aliases: ["testosterone", "testo", "testosteronas"],
    category: "hormones",
    canonicalUnit: "nmol/L",
    loincCode: "2986-8",
    molarMassGMol: 288.42,
  },
  {
    slug: "cortisol",
    name: "Cortisol",
    aliases: ["cortisol", "kortizolis"],
    category: "hormones",
    canonicalUnit: "nmol/L",
    loincCode: "2143-6",
    molarMassGMol: 362.46,
  },
];

/**
 * Validates the catalog before anything is inserted: every canonical_unit
 * must be a valid UCUM code, slugs unique, required fields non-empty.
 * Throws an Error listing every problem found.
 */
export function validateBiomarkerCatalog(): void {
  const ucum = UcumLhcUtils.getInstance();
  const problems: string[] = [];
  const seenSlugs = new Set<string>();
  for (const entry of BIOMARKER_SEED) {
    if (!entry.slug) problems.push("entry with empty slug");
    if (seenSlugs.has(entry.slug)) {
      problems.push(`${entry.slug}: duplicate slug`);
    }
    seenSlugs.add(entry.slug);
    if (!entry.name) problems.push(`${entry.slug}: empty name`);
    if (entry.aliases.length === 0) {
      problems.push(`${entry.slug}: no aliases`);
    }
    if (ucum.validateUnitString(entry.canonicalUnit).status !== "valid") {
      problems.push(
        `${entry.slug}: canonical_unit "${entry.canonicalUnit}" is not valid UCUM`,
      );
    }
    if (
      entry.molarMassGMol !== undefined &&
      !(entry.molarMassGMol > 0 && Number.isFinite(entry.molarMassGMol))
    ) {
      problems.push(`${entry.slug}: invalid molar_mass_g_mol`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid biomarker catalog:\n- ${problems.join("\n- ")}`);
  }
}
