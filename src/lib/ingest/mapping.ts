// As-reported analyte name → biomarkers catalog matching.
//
// Two deterministic passes run before any LLM fallback (worker/normalize.ts):
//   1. exact — the normalized candidate equals a normalized alias, slug, or
//      catalog name;
//   2. fuzzy — containment ("Vitamin D (25-OH)" covers alias "vitamin d") or
//      a small Levenshtein distance (lab abbreviations like LT "TTG" vs alias
//      "tth", typos like "hemoglobiin").
//
// Normalization folds case and diacritics (Lithuanian ąčęėįšųūž) and
// collapses punctuation/whitespace, so matching is spelling-insensitive but
// still deterministic. Nothing here writes back to the catalog — only
// LLM-confirmed mappings are persisted (see worker/normalize.ts).
//
// Pure module: no imports, so it loads under plain node type stripping in the
// worker and under vitest alike.

/** The catalog fields matching needs (structurally compatible with a row). */
export interface CatalogEntry {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
}

export interface BiomarkerMatch {
  entry: CatalogEntry;
  via: "exact" | "fuzzy";
  /** The alias/slug/name the candidate matched against. */
  matchedTerm: string;
}

/**
 * Matching normalization: lowercase, NFD diacritic folding, every run of
 * non-alphanumeric characters collapsed to one space. Applied to both sides
 * ("Vitamin D (25-OH)" and alias "25-OH vitamin D" both lose their punctuation).
 */
export function normalizeAnalyteName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Classic Levenshtein; names here are short, so the O(n·m) DP is fine. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** Every term an entry can be matched by: slug, display name, then aliases. */
function termsOf(entry: CatalogEntry): string[] {
  return [entry.slug, entry.name, ...entry.aliases];
}

/** Aliases this short ("hb", "ca") must not containment-match the world. */
const MIN_CONTAINMENT_LENGTH = 4;

/**
 * Levenshtein budgets. Below 3 characters any edit lands somewhere
 * meaningless, so no fuzzy at all. Short abbreviations only tolerate a
 * same-length substitution (LT "TTG" → alias "tth"); an insertion would
 * already bridge "TTG" → "trig"(lycerides), a wrong measurand. Longer terms
 * get 2 edits of any kind (typos like "hemoglobiin").
 */
const MIN_LEVENSHTEIN_LENGTH = 3;

function maxDistanceFor(candidate: string, normalizedTerm: string): number {
  if (normalizedTerm.length < MIN_LEVENSHTEIN_LENGTH) return 0;
  if (normalizedTerm.length >= 8) return 2;
  return candidate.length === normalizedTerm.length ? 1 : 0;
}

/**
 * Matches an as-reported analyte name against the catalog. Exact matches
 * always win over fuzzy; within fuzzy, containment beats Levenshtein and the
 * longest contained term / smallest distance wins, with catalog order as the
 * final tie-break so results are deterministic. Returns null when nothing
 * clears a threshold — the caller falls back to the LLM mapping.
 */
export function matchBiomarker(
  rawName: string,
  catalog: CatalogEntry[],
): BiomarkerMatch | null {
  const candidate = normalizeAnalyteName(rawName);
  if (!candidate) return null;

  for (const entry of catalog) {
    for (const term of termsOf(entry)) {
      if (normalizeAnalyteName(term) === candidate) {
        return { entry, via: "exact", matchedTerm: term };
      }
    }
  }

  let bestContainment: { match: BiomarkerMatch; length: number } | null = null;
  for (const entry of catalog) {
    for (const term of termsOf(entry)) {
      const normalized = normalizeAnalyteName(term);
      if (normalized.length < MIN_CONTAINMENT_LENGTH) continue;
      if (candidate.includes(normalized) || normalized.includes(candidate)) {
        if (!bestContainment || normalized.length > bestContainment.length) {
          bestContainment = {
            match: { entry, via: "fuzzy", matchedTerm: term },
            length: normalized.length,
          };
        }
      }
    }
  }
  if (bestContainment) return bestContainment.match;

  let bestDistance: { match: BiomarkerMatch; distance: number } | null = null;
  for (const entry of catalog) {
    for (const term of termsOf(entry)) {
      const normalized = normalizeAnalyteName(term);
      const distance = levenshtein(candidate, normalized);
      if (distance === 0 || distance > maxDistanceFor(candidate, normalized)) {
        continue;
      }
      if (!bestDistance || distance < bestDistance.distance) {
        bestDistance = {
          match: { entry, via: "fuzzy", matchedTerm: term },
          distance,
        };
      }
    }
  }
  return bestDistance?.match ?? null;
}
