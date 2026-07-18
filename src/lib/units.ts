// Unit normalization and conversion for lab results.
//
// Lab reports spell units loosely ("mmol/l", "10^9/L", "µIU/mL"). This module
// normalizes those spellings to canonical UCUM codes and converts as-reported
// values into a biomarker's canonical unit:
//   1. commensurable conversions (mg/dL -> g/L, ng/mL -> ug/L) go through
//      @lhncbc/ucum-lhc;
//   2. mol <-> mass conversions use the biomarker's molar mass (mg/dL->mmol/L
//      is value*10/molar_mass, the reverse is value*molar_mass/10);
//   3. anything without a conversion path returns null — we never guess.
//
// Nothing here throws on garbage input; every failure mode is a null/"".

import { UcumLhcUtils } from "@lhncbc/ucum-lhc";

const ucum = UcumLhcUtils.getInstance();

/**
 * The unit context convertToCanonical needs from a biomarker row.
 * Structurally compatible with the drizzle `biomarkers` select type.
 */
export interface BiomarkerUnitContext {
  canonicalUnit: string;
  molarMassGMol?: number | null;
}

// Whole-token case fixes for common lab-report spellings, applied per
// "/"-separated token and matched case-insensitively (after µ->u, ^->*).
// UCUM is case-sensitive ("mL" != "ml", "L" != "l"); lab reports are not.
const TOKEN_FIXES: Record<string, string> = {
  l: "L",
  dl: "dL",
  ml: "mL",
  ul: "uL",
  fl: "fL",
  pl: "pL",
  cl: "cL",
  mmol: "mmol",
  umol: "umol",
  nmol: "nmol",
  pmol: "pmol",
  fmol: "fmol",
  mol: "mol",
  kg: "kg",
  g: "g",
  mg: "mg",
  ug: "ug",
  ng: "ng",
  pg: "pg",
  uiu: "u[IU]",
  miu: "m[IU]",
  iu: "[IU]",
  u: "U",
  "%": "%",
};

function isValidUcum(code: string): boolean {
  try {
    return ucum.validateUnitString(code).status === "valid";
  } catch {
    return false;
  }
}

/**
 * Normalizes a raw unit string to its canonical UCUM spelling: trims, strips
 * internal spaces, maps µ/μ->u and ^->* (10^9/L -> 10*9/L), and case-fixes
 * common tokens (mmol/l -> mmol/L, mg/dl -> mg/dL, µIU/mL -> u[IU]/mL).
 * Returns the best-effort normalization — a string that still fails UCUM
 * validation when the input is not a recognizable unit (never throws).
 */
export function normalizeUnitString(raw: string): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "")
    .replace(/[µμ]/g, "u")
    .replace(/\^/g, "*");
  if (!cleaned) return "";
  // Token fixes win over raw validity: lab reports write "G/L" for grams and
  // "U/L" for enzyme units, colliding with UCUM's gauss and atomic-mass-unit.
  const fixed = cleaned
    .split("/")
    .map((token) => TOKEN_FIXES[token.toLowerCase()] ?? token)
    .join("/");
  if (isValidUcum(fixed)) return fixed;
  if (isValidUcum(cleaned)) return cleaned;
  return cleaned;
}

function commensurableFactor(fromUnit: string, toUnit: string): number | null {
  try {
    const result = ucum.convertUnitTo(fromUnit, 1, toUnit);
    if (
      result.status === "succeeded" &&
      typeof result.toVal === "number" &&
      Number.isFinite(result.toVal) &&
      result.toVal > 0
    ) {
      return result.toVal;
    }
  } catch {
    // fall through to null
  }
  return null;
}

// mol <-> mass via the biomarker's molar mass (g/mol), routed through g/L and
// mol/L so any mass-concentration <-> molar-concentration pair converts (the
// classic mg/dL <-> mmol/L reduces to value*10/M and value*M/10).
function convertViaMolarMass(
  value: number,
  fromUnit: string,
  toUnit: string,
  molarMassGMol: number,
): number | null {
  const fromMass = commensurableFactor(fromUnit, "g/L");
  const toMolar = commensurableFactor("mol/L", toUnit);
  if (fromMass !== null && toMolar !== null) {
    // g/L -> mol/L is /M; then scale mol/L into the target unit.
    return ((value * fromMass) / molarMassGMol) * toMolar;
  }
  const fromMolar = commensurableFactor(fromUnit, "mol/L");
  const toMass = commensurableFactor("g/L", toUnit);
  if (fromMolar !== null && toMass !== null) {
    // mol/L -> g/L is *M; then scale g/L into the target unit.
    return value * fromMolar * molarMassGMol * toMass;
  }
  return null;
}

/**
 * Converts `value` from `fromUnit` (as reported) into the biomarker's
 * canonical unit. Returns null when either unit is unrecognizable or no
 * conversion path exists (incommensurable units and no molar mass) — the
 * caller stores value_canonical as null rather than a guessed number.
 */
export function convertToCanonical(
  value: number,
  fromUnit: string,
  biomarker: BiomarkerUnitContext,
): number | null {
  if (!Number.isFinite(value)) return null;
  const from = normalizeUnitString(fromUnit);
  const to = biomarker.canonicalUnit;
  if (!from || !to) return null;
  if (from === to) return value;
  if (!isValidUcum(from) || !isValidUcum(to)) return null;

  const factor = commensurableFactor(from, to);
  if (factor !== null) return value * factor;

  const molarMass = biomarker.molarMassGMol;
  if (
    typeof molarMass === "number" &&
    Number.isFinite(molarMass) &&
    molarMass > 0
  ) {
    return convertViaMolarMass(value, from, to, molarMass);
  }
  return null;
}
