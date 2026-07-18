# Kimi smoke eval — live API, EN+LT documents (health-etv.10)

Date: 2026-07-18 · Branch: `epic/health-etv.10` · Model under test: `kimi-k2.6`
(all pipeline stages; no `kimi-k3` escalation was triggered by any sample)

Four samples in `fixtures/health-docs/` were ingested through the **real**
pipeline stages (`worker/classify.ts` → `worker/extract.ts` →
`worker/normalize.ts`; the summarizing stage was stubbed — out of scope) by
`scripts/kimi-smoke.ts`, against a scratch Postgres + MinIO and the live
Moonshot API. Ground truth for the two lab PDFs comes from
`fixtures/health-docs/content.mjs` (the same source that renders the PDFs, so
fixtures and expectations cannot drift).

## Reproduce

```bash
docker compose -p health-smoke up -d db minio
export MOONSHOT_API_KEY=...            # token store; never commit
export SMOKE_DATABASE_URL=postgres://postgres:postgres@localhost:5433/health_smoke
export S3_ENDPOINT=http://localhost:9000 S3_BUCKET=health-smoke \
       S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...   # MinIO root creds
node --experimental-strip-types scripts/kimi-smoke.ts
```

The script self-provisions (creates + migrates the database, seeds the
biomarker catalog, creates the bucket) and wipes the scratch state on every
run, so normalize's mapping split is always measured against a fresh catalog.
**Manual runs only — the API costs money.** Full machine-readable output:
`SMOKE_REPORT_PATH` (default `/tmp/kimi-smoke-report.json`).

## Per-document results

### lt-lab.pdf — Lithuanian lab report (11 analytes, decimal commas, diacritics)

- **Classify**: `lab_report`, confidence 1.0, language `lt`, via Kimi.
  Summary: "Blood panel (11 analytes) from SYNLAB Lietuva, sampled 2026-04-02."
- **Extract** (kimi-k2.6, valid on first attempt, no retry/escalation):
  **11/11 analytes, 100% field-perfect** — every name (byte-exact LT
  diacritics: `Gliukozė`, `Bendrasis cholesterinas`), value (decimal commas
  converted: `13,8` → 13.8), unit, reference bound and flag matched the
  fixture; `measuredOn` correctly picked the collection date (`Mėginio data`
  2026-04-02, persisted as `document_date`); provider `SYNLAB Lietuva`.
- **Normalize**: 10 exact + 1 fuzzy catalog matches, **0 LLM fallbacks
  needed**, 11 results inserted, 0 unmapped.

### en-cbc.pdf — English CBC + metabolic panel (21 analytes)

- **Classify**: `lab_report`, confidence 0.99, language `en`.
- **Extract** (kimi-k2.6, first attempt): **21/21 analytes, 100%
  field-perfect**, including the `LDL cholesterol → flag: high` abnormality
  marker and `<3.0`-style textual references. Collection date 2026-03-14 and
  provider persisted correctly.
- **Normalize**: 19 exact + 1 LLM mapping (`Carbamide` → `bun`, correct —
  carbamide = urea; alias written back to the catalog), `Homocysteine`
  correctly left **unmapped** (no catalog entry — LLM answered null instead of
  guessing). 20 results inserted.

### wearable-garmin.csv — Garmin daily metrics CSV

- **Classify**: `wearable_export` **deterministically** (header shape — zero
  Kimi tokens, 9 ms).
- **Extract**: skipped by the pipeline dispatcher for `wearable_export` (the
  stage wiring is a known open seam, health-etv.21's parser landed
  separately). Run directly, the deterministic Garmin plugin parsed with
  confidence ≈1.0: 6 daily metrics (steps + resting HR for 3 days) on the
  metric-names contract.

### scanned.pdf — image-only PDF, no text layer (scanned stand-in)

- **Bug found**: Moonshot rejects a file-extract upload of an image-only PDF
  at **upload time** with `400 text extract error: 没有解析出内容` — not with
  the empty-content body the code expected. Unhandled, this crashed the
  classifying stage (the document would have burned pg-boss retries into
  `failed`).
- **Fixed in this branch**: `isNoTextLayerError()` in `src/lib/kimi/files.ts`
  (also maps the 400 at content-fetch to `kind: "empty"`), and the classify
  stage treats it as "no text" → falls back to filename + raw head sample.
- **Post-fix behavior**: Kimi classified the raw-head fallback as `unknown`
  (confidence 0.95: "Minimal PDF containing only vector graphic elements… no
  readable text or health-related content") → document `ignored`. Correct for
  this content-free fixture — see verdict (b) for what it means for real
  scanned lab reports.

## Tokens, cost, latency (this run)

Price assumption: `$0.95 / $4.00` per 1M input/output tokens (Moonshot list
price for kimi-k2.6, 2026-06; override via `KIMI_PRICE_INPUT/OUTPUT_PER_MTOK`).
Output tokens **include reasoning** (k2.6 is a thinking model — roughly 2/3 of
output on extractions is reasoning, not JSON).

| document    | call              | latency          | in tok   | out tok   | cost        |
| ----------- | ----------------- | ---------------- | -------- | --------- | ----------- |
| lt-lab.pdf  | classification    | 21.9 s           | 701      | 829       | $0.0040     |
| lt-lab.pdf  | lab_extraction    | 87.0 s           | 636      | 4167      | $0.0173     |
| en-cbc.pdf  | classification    | 10.9 s           | 808      | 510       | $0.0028     |
| en-cbc.pdf  | lab_extraction    | 40.8 s           | 741      | 3871      | $0.0162     |
| en-cbc.pdf  | biomarker_mapping | 23.9 s           | 518      | 1364      | $0.0059     |
| scanned.pdf | classification    | 32.1 s           | 671      | 1920      | $0.0083     |
| **total**   | 6 calls           | **225.8 s wall** | **4075** | **12661** | **$0.0545** |

Stage latencies: LT classifying 26.6 s (includes Files API round-trip) /
extracting 87.1 s / normalizing 18 ms; EN 14.4 s / 40.8 s / 23.9 s; wearable
9 ms total (no Kimi). A repeat run of the same samples showed ±25% token and
latency variance (reasoning length is nondeterministic).

## Verdicts

### (a) Lithuanian extraction quality — EXCELLENT, risk resolved

100% of analytes extracted, 100% field-perfect values/units/references/flags,
byte-exact LT diacritics, decimal commas converted correctly, the collection
date chosen correctly among several dates, and catalog mapping resolved
without any LLM fallback. This confirms the earlier real-report eval (91/91
analytes from a UAB Hila report) on controlled fixtures. No prompt changes or
k3 escalation warranted. Byte-level caveats for downstream code (both are
semantically identical, not errors):

- `µmol/L` printed as U+00B5 (micro sign) came back as U+03BC (Greek mu) —
  the units module must keep normalizing both (it does).
- `referenceText` keeps the printed decimal comma (`<5,2`) — by design it is
  the raw reference string; numeric conversion applies to `value` only.

### (b) Empty-text scanned PDFs — handled safely now; VISION FALLBACK IS NEEDED

The text-first path degrades safely: file-extract rejection (400 at upload)
and thin unpdf text (<100 chars) are both handled — the document can no longer
crash the pipeline. But a **real scanned lab report has no readable text
anywhere the classifier can see it**: like our fixture it will most likely be
classified `unknown` → `ignored` (silently!) or, with a suggestive filename,
`needs_review`. Either way its data is never extracted. Recommendation for the
vision-path issue: when file-extract yields no text, render page images and
classify from those (ms:// image refs), so scanned labs can reach
`lab_report` + vision extraction instead of being silently ignored. The
extract-stage `needs_review("scanned")` halt only fires for documents already
classified as lab reports, which raw-head classification will rarely manage
for image-only content.

### (c) Tier0 rate-limit behavior — queue copes; latency is the real constraint

Zero 429s across the whole run: 6 chat calls + Files API
upload/content/delete traffic, all serialized through `kimiQueue` at
concurrency 1. Effective rate ≈1.6 calls/min against the 3 RPM Tier0 cap —
comfortable headroom, and `withBackoff` never had to fire. The throughput
constraint is call latency, not the RPM cap: 22–87 s per call (extraction of a
small one-page report ≈90 s end-to-end; the real 91-analyte LT report took
≈4.5 min). Expect ≈30–40 small documents/hour serially; pg-boss's retry +
the worker's 600 s expire window remain correctly sized.

## Fixes shipped with this eval (same branch)

- `src/lib/kimi/files.ts`: `isNoTextLayerError()` — map Moonshot's
  `400 text extract error` (no parseable text layer) to `kind: "empty"` at
  content fetch; exported for callers.
- `worker/classify.ts`: treat the same error at **upload** time as "no text"
  and fall back to filename + raw head sample instead of crashing the stage.
- `src/app/api/documents/[id]/reprocess/route.test.ts`: pre-existing failure
  on main — expected 3 cached stages but `INGESTION_STAGES` has 4 since the
  summarizing stage landed; assertion now tracks `INGESTION_STAGES`.
- `src/lib/kimi/client.ts`: optional `onUsage` observer on `chatStructured`
  so the eval (and future telemetry) can record token usage per call.
