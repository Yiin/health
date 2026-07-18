// Deterministic biomarker flag engine. PURE TypeScript — no LLM, no DB — so
// the rules are unit-tested on fixture data and every surface (overview
// "needs attention" strip, /insights flag cards, labs TrendChart callouts)
// shows the same flags for the same series.
//
// Three flag kinds:
//   out_of_range   — a draw outside its reference range (per draw).
//   big_delta      — a large relative change vs the previous draw (per pair,
//                    attached to the later draw).
//   trend_reversal — the latest move reverses an established trend: at least
//                    `reversalRunMoves` same-direction moves (a trend spanning
//                    3+ draws) immediately followed by an opposite final move.
//                    Only ever flags the LATEST draw — a stale mid-history
//                    reversal carries no "needs attention" signal.
//
// Input draws are one biomarker's series; values are canonical-unit (null for
// unconvertible rows — those draws are skipped, never guessed).

export interface FlagDraw {
  /** YYYY-MM-DD. */
  date: string;
  /** Canonical-unit value; null draws (unconvertible unit) are skipped. */
  value: number | null;
  refLow?: number | null;
  refHigh?: number | null;
}

export type FlagKind = "out_of_range" | "big_delta" | "trend_reversal";

/** warning = act on it, info = worth knowing. */
export type FlagSeverity = "warning" | "info";

export interface BiomarkerFlag {
  kind: FlagKind;
  /** Date of the draw the flag attaches to. */
  date: string;
  severity: FlagSeverity;
  /** Full sentence for cards and strips. */
  message: string;
  /** Compact label for chart callouts and chips ("High 7.2", "+42%"). */
  shortLabel: string;
  /** The flagged draw's value. */
  value: number;
}

export interface FlagOptions {
  /**
   * Relative change vs the previous draw at or above which the pair flags:
   * |v − prev| / |prev| >= deltaThreshold. Default 0.25 (25%). A previous
   * value of 0 makes the relative change undefined, so that pair never flags.
   */
  deltaThreshold?: number;
  /**
   * Same-direction moves required before the final opposite move to call a
   * trend reversal. Default 2 — the established trend spans 3+ draws. Pass 1
   * to make any 3-draw zigzag (up-then-down) count.
   */
  reversalRunMoves?: number;
}

export const DEFAULT_DELTA_THRESHOLD = 0.25;
export const DEFAULT_REVERSAL_RUN_MOVES = 2;

export const FLAG_KIND_LABELS: Record<FlagKind, string> = {
  out_of_range: "Out of range",
  big_delta: "Big change",
  trend_reversal: "Trend reversal",
};

/** Compact display for biomarker magnitudes (5.5, 0.0831, 1234). */
export function formatFlagValue(value: number): string {
  return String(Number(value.toPrecision(4)));
}

function referenceText(low: number | null, high: number | null): string {
  if (low !== null && high !== null) {
    return `ref ${formatFlagValue(low)}–${formatFlagValue(high)}`;
  }
  if (high !== null) return `ref ≤ ${formatFlagValue(high)}`;
  if (low !== null) return `ref ≥ ${formatFlagValue(low)}`;
  // Unreachable — callers only ask with at least one bound present.
  return "no reference range";
}

type ValuedDraw = FlagDraw & { value: number };

function outOfRangeFlag(draw: ValuedDraw): BiomarkerFlag | null {
  const low = draw.refLow ?? null;
  const high = draw.refHigh ?? null;
  if (low === null && high === null) return null;
  const value = formatFlagValue(draw.value);
  if (low !== null && draw.value < low) {
    return {
      kind: "out_of_range",
      date: draw.date,
      severity: "warning",
      message: `Below reference range: ${value} (${referenceText(low, high)})`,
      shortLabel: `Low ${value}`,
      value: draw.value,
    };
  }
  if (high !== null && draw.value > high) {
    return {
      kind: "out_of_range",
      date: draw.date,
      severity: "warning",
      message: `Above reference range: ${value} (${referenceText(low, high)})`,
      shortLabel: `High ${value}`,
      value: draw.value,
    };
  }
  return null;
}

function bigDeltaFlag(
  draw: ValuedDraw,
  previous: ValuedDraw,
  deltaThreshold: number,
): BiomarkerFlag | null {
  if (previous.value === 0) return null;
  const relative = (draw.value - previous.value) / Math.abs(previous.value);
  if (Math.abs(relative) < deltaThreshold) return null;
  const percent = Math.round(relative * 100);
  const sign = relative > 0 ? "+" : "";
  return {
    kind: "big_delta",
    date: draw.date,
    severity: "warning",
    message:
      `${sign}${percent}% vs previous draw ` +
      `(${formatFlagValue(previous.value)} → ${formatFlagValue(draw.value)})`,
    shortLabel: `${sign}${percent}%`,
    value: draw.value,
  };
}

/**
 * The reversal check: the final move must go against a run of at least
 * `runMoves` same-direction moves immediately before it. Flat moves (0) break
 * the run — the trend must be strict. Attached to the latest draw only.
 */
function trendReversalFlag(
  valued: ValuedDraw[],
  runMoves: number,
): BiomarkerFlag | null {
  if (valued.length < runMoves + 2) return null;
  const moves: number[] = [];
  for (let i = 1; i < valued.length; i++) {
    moves.push(Math.sign(valued[i].value - valued[i - 1].value));
  }
  const lastDirection = moves[moves.length - 1];
  if (lastDirection === 0) return null;
  let run = 0;
  for (let i = moves.length - 2; i >= 0; i--) {
    if (moves[i] === -lastDirection) run++;
    else break;
  }
  if (run < runMoves) return null;
  const latest = valued[valued.length - 1];
  const nowWord = lastDirection > 0 ? "rising" : "falling";
  const wasWord = lastDirection > 0 ? "falling" : "rising";
  return {
    kind: "trend_reversal",
    date: latest.date,
    severity: "info",
    message: `Trend reversal: ${wasWord} across ${run + 1} draws, now ${nowWord}`,
    shortLabel: "Reversal",
    value: latest.value,
  };
}

/**
 * Every flag for one biomarker's series, in ascending date order (the
 * reversal, when present, comes last — it only ever attaches to the latest
 * draw). Draws are sorted by date defensively; null-valued draws are skipped.
 */
export function computeFlags(
  draws: FlagDraw[],
  options: FlagOptions = {},
): BiomarkerFlag[] {
  const deltaThreshold = Math.max(
    0,
    options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD,
  );
  const runMoves = Math.max(
    1,
    Math.floor(options.reversalRunMoves ?? DEFAULT_REVERSAL_RUN_MOVES),
  );
  const valued = draws
    .filter((draw): draw is ValuedDraw => draw.value !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const flags: BiomarkerFlag[] = [];
  for (let i = 0; i < valued.length; i++) {
    const rangeFlag = outOfRangeFlag(valued[i]);
    if (rangeFlag) flags.push(rangeFlag);
    if (i > 0) {
      const deltaFlag = bigDeltaFlag(valued[i], valued[i - 1], deltaThreshold);
      if (deltaFlag) flags.push(deltaFlag);
    }
  }
  const reversalFlag = trendReversalFlag(valued, runMoves);
  if (reversalFlag) flags.push(reversalFlag);
  return flags;
}

/**
 * The needs-attention view: only flags attached to the most recent draw with
 * a value. Mid-history out-of-range draws and deltas are chart context, not
 * current signal.
 */
export function latestFlags(
  draws: FlagDraw[],
  options: FlagOptions = {},
): BiomarkerFlag[] {
  const valued = draws.filter((draw) => draw.value !== null);
  if (valued.length === 0) return [];
  let latestDate = valued[0].date;
  for (const draw of valued) {
    if (draw.date > latestDate) latestDate = draw.date;
  }
  return computeFlags(draws, options).filter((flag) => flag.date === latestDate);
}

/** Flags mapped onto TrendChart's callouts prop (compact labels). */
export function calloutsForFlags(flags: BiomarkerFlag[]): {
  date: string;
  label: string;
  severity: FlagSeverity;
}[] {
  return flags.map((flag) => ({
    date: flag.date,
    label: flag.shortLabel,
    severity: flag.severity,
  }));
}
