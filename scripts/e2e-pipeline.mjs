// End-to-end pipeline test, run INSIDE the compose network by the `e2e`
// service of docker-compose.e2e.yml (see README "E2E pipeline test"):
//
//   npm run e2e         # reuse the last-built web/worker images
//   npm run e2e:image   # rebuild all service images first (deploy validation)
//
// Uploads one fixture of every supported shape through the REAL stack — web
// upload route → pg-boss → worker stages → Postgres/MinIO — with only the
// Moonshot API replaced by the deterministic kimi-mock service, then asserts
// the final database state per document. A second phase flips the mock into
// outage mode and proves the retry semantics: outage-classed failures retry
// with backoff without consuming real ingestion attempts, exhaustion lands in
// `failed` with an actionable stage_error, and restoring connectivity + the
// retry endpoint completes the ingestion.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import postgres from "postgres";

const WEB_URL = process.env.WEB_URL ?? "http://web:3000";
const KIMI_MOCK_URL = process.env.KIMI_MOCK_URL ?? "http://kimi-mock:9700";
const DATABASE_URL = process.env.DATABASE_URL;
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "/app/fixtures/health-docs";
// Cadence of every waitFor probe. The probes are single-row selects or HTTP
// GETs against an otherwise idle stack, so a tight default costs nothing and
// stops each of the ~7 waits from overshooting its condition by up to 1s.
const POLL_MS = Number(process.env.E2E_POLL_MS) || 150;

if (!DATABASE_URL) {
  console.error("[e2e] DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await probe();
      if (result !== undefined && result !== false) return result;
    } catch {
      // keep waiting
    }
    if (Date.now() > deadline) {
      throw new Error(`[e2e] timed out waiting for ${label}`);
    }
    await sleep(POLL_MS);
  }
}

async function uploadFiles(entries) {
  const form = new FormData();
  for (const { filename, bytes, contentType } of entries) {
    form.append(
      "file",
      new Blob([bytes], { type: contentType ?? "application/octet-stream" }),
      filename,
    );
  }
  const response = await fetch(`${WEB_URL}/api/uploads`, {
    method: "POST",
    body: form,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `[e2e] upload failed ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  const byName = new Map();
  for (const file of body.files) {
    if (!file.ok) {
      throw new Error(
        `[e2e] upload of ${file.filename} rejected: ${JSON.stringify(file)}`,
      );
    }
    byName.set(file.filename, file.documentId);
  }
  return byName;
}

const TERMINAL = ["done", "failed", "needs_review", "ignored"];

async function waitForTerminal(documentIds, timeoutMs) {
  return waitFor(
    `documents ${documentIds.join(", ")} to reach a terminal status`,
    async () => {
      const rows = await sql`
        select id, status from documents where id in ${sql(documentIds)}
      `;
      const pending = rows.filter((row) => !TERMINAL.includes(row.status));
      return pending.length === 0 ? rows : false;
    },
    timeoutMs,
  );
}

async function documentRow(id) {
  const [row] = await sql`
    select id, status, document_type, provider, document_date::text,
           ai_summary, stage_error, attempts
    from documents where id = ${id}
  `;
  return row;
}

// ---------------------------------------------------------------------------
// In-memory zip writer (store method) for the Takeout fixture
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal STORE-method zip: enough structure for ranged CD reads + unzipper. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, "utf-8");
    const data = Buffer.from(content, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10); // store
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBytes, eocd]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOGLE_FIT_CSV = [
  "Date,Move Minutes count,Calories (kcal),Distance (m),Step count",
  "2024-06-01,42,2145,3251.4,4871",
  "2024-06-02,67,2380,5412.8,8123",
  "",
].join("\n");

const APPLE_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="e2e" unit="count" startDate="2024-05-01 09:00:00 +0300" endDate="2024-05-01 09:30:00 +0300" value="5000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="e2e" unit="count" startDate="2024-05-01 18:00:00 +0300" endDate="2024-05-01 18:20:00 +0300" value="2500"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="e2e" unit="count/min" startDate="2024-05-01 08:00:00 +0300" endDate="2024-05-01 08:00:00 +0300" value="52"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="31.5" durationUnit="min" startDate="2024-05-01 19:00:00 +0300" endDate="2024-05-01 19:31:30 +0300" sourceName="e2e">
 </Workout>
</HealthData>
`;

const UNKNOWN_TXT = [
  "Shopping list",
  "- oat milk",
  "- rye bread",
  "- coffee beans",
  "Nothing medical about this file at all.",
].join("\n");

/**
 * Lab-report-shaped plain text for the outage phase (fresh bytes, so the
 * sha256 dedup never collides with the PDF fixtures). Same column discipline
 * the mock's deterministic extraction parses.
 */
const OUTAGE_LAB_TXT = [
  "City Central Laboratory",
  "Laboratory: City Central Laboratory",
  "Collected: 2026-05-10",
  "Report: Follow-up panel (e2e outage fixture)",
  "",
  "Name  Value  Unit  Reference",
  "Hemoglobin  13.9  g/dL  12.0-16.0",
  "Glucose  92  mg/dL  70-99",
  "Ferritin  95  ug/L  20-250",
].join("\n");

function fixture(filename) {
  return new Uint8Array(readFileSync(path.join(FIXTURES_DIR, filename)));
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function setMockMode(mode) {
  const response = await fetch(`${KIMI_MOCK_URL}/__mock/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`[e2e] failed to set mock mode ${mode}`);
  console.log(`[e2e] kimi-mock mode → ${mode}`);
}

async function setOutageMarkers(markers) {
  const response = await fetch(`${KIMI_MOCK_URL}/__mock/outage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markers }),
  });
  if (!response.ok) {
    throw new Error(`[e2e] failed to set outage markers [${markers}]`);
  }
  console.log(`[e2e] kimi-mock outage markers → [${markers}]`);
}

async function phaseHappyPath() {
  console.log(
    "\n[e2e] PHASE 1 — one fixture of each type through the pipeline",
  );
  const uploads = await uploadFiles([
    {
      filename: "en-cbc.pdf",
      bytes: fixture("en-cbc.pdf"),
      contentType: "application/pdf",
    },
    {
      filename: "lt-lab.pdf",
      bytes: fixture("lt-lab.pdf"),
      contentType: "application/pdf",
    },
    {
      filename: "scanned.pdf",
      bytes: fixture("scanned.pdf"),
      contentType: "application/pdf",
    },
    {
      filename: "wearable-garmin.csv",
      bytes: fixture("wearable-garmin.csv"),
      contentType: "text/csv",
    },
    {
      filename: "takeout.zip",
      bytes: buildZip([
        {
          name: "Takeout/Fit/Daily activity metrics/Daily activity metrics.csv",
          content: GOOGLE_FIT_CSV,
        },
        {
          name: "Takeout/Fit/Daily activity metrics/2024-06-01.json",
          content: "{}",
        },
      ]),
      contentType: "application/zip",
    },
    {
      filename: "export.xml",
      bytes: Buffer.from(APPLE_EXPORT_XML),
      contentType: "application/xml",
    },
    {
      filename: "unknown.txt",
      bytes: Buffer.from(UNKNOWN_TXT),
      contentType: "text/plain",
    },
  ]);
  console.log(`[e2e] uploaded ${uploads.size} fixtures`);

  await waitForTerminal([...uploads.values()], 240_000);
  // The takeout parent completes only after its children do; wait for those
  // separately (they are created by the worker, not the upload).
  const takeoutId = uploads.get("takeout.zip");
  await waitFor(
    "takeout children to reach terminal statuses and the parent to complete",
    async () => {
      const [parent] = await sql`
        select status from documents where id = ${takeoutId}
      `;
      return TERMINAL.includes(parent.status);
    },
    120_000,
  );

  // --- EN lab PDF -------------------------------------------------------
  {
    const doc = await documentRow(uploads.get("en-cbc.pdf"));
    console.log("[e2e] en-cbc.pdf:");
    check(
      "status done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "classified lab_report",
      doc.document_type === "lab_report",
      doc.document_type,
    );
    check(
      "provider extracted",
      doc.provider === "City Central Laboratory",
      String(doc.provider),
    );
    check(
      "document date extracted",
      doc.document_date === "2026-03-14",
      String(doc.document_date),
    );
    check(
      "ai summary written",
      typeof doc.ai_summary === "string" && doc.ai_summary.length > 0,
    );
    const results = await sql`
      select b.slug, r.value::float8 as value
      from biomarker_results r join biomarkers b on b.id = r.biomarker_id
      where r.document_id = ${doc.id}
    `;
    check(
      "≥10 biomarker results persisted",
      results.length >= 10,
      `got ${results.length}`,
    );
    const hemoglobin = results.find((row) => row.slug === "hemoglobin");
    check(
      "hemoglobin mapped with value 14.2",
      hemoglobin?.value === 14.2,
      JSON.stringify(hemoglobin),
    );
    const insights = await sql`
      select id from ai_insights where source_refs @> ${sql.json([{ kind: "document", id: doc.id }])}
    `;
    check(
      "post-ingestion insight filed",
      insights.length === 1,
      `got ${insights.length}`,
    );
  }

  // --- LT lab PDF -------------------------------------------------------
  {
    const doc = await documentRow(uploads.get("lt-lab.pdf"));
    console.log("[e2e] lt-lab.pdf:");
    check(
      "status done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "classified lab_report",
      doc.document_type === "lab_report",
      doc.document_type,
    );
    check(
      "provider extracted",
      doc.provider === "SYNLAB Lietuva",
      String(doc.provider),
    );
    const results = await sql`
      select b.slug, r.value::float8 as value
      from biomarker_results r join biomarkers b on b.id = r.biomarker_id
      where r.document_id = ${doc.id}
    `;
    check(
      "≥6 biomarker results persisted",
      results.length >= 6,
      `got ${results.length}`,
    );
    const hemoglobin = results.find((row) => row.slug === "hemoglobin");
    check(
      "Hemoglobinas mapped via LT alias, decimal comma converted",
      hemoglobin?.value === 13.8,
      JSON.stringify(hemoglobin),
    );
  }

  // --- Scanned PDF (blank scan) -----------------------------------------
  // scanned.pdf has no text layer AND no readable content: the worker
  // rasterizes it, vision extraction validly returns zero analytes, and the
  // document parks in needs_review for a human.
  {
    const doc = await documentRow(uploads.get("scanned.pdf"));
    console.log("[e2e] scanned.pdf:");
    check("status needs_review", doc.status === "needs_review", doc.status);
    check(
      "stage_error explains the empty scan",
      /no analytes/i.test(doc.stage_error?.message ?? ""),
      JSON.stringify(doc.stage_error),
    );
  }

  // --- Wearable CSV -----------------------------------------------------
  {
    const doc = await documentRow(uploads.get("wearable-garmin.csv"));
    console.log("[e2e] wearable-garmin.csv:");
    check(
      "status done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "classified wearable_export",
      doc.document_type === "wearable_export",
      doc.document_type,
    );
    const [steps] = await sql`
      select value::float8 as value from daily_metrics
      where source = 'garmin' and metric = 'steps' and metric_on = '2024-03-01'
    `;
    check(
      "garmin steps persisted (2024-03-01 = 9234)",
      steps?.value === 9234,
      JSON.stringify(steps),
    );
    const [restingHr] = await sql`
      select value::float8 as value from daily_metrics
      where source = 'garmin' and metric = 'resting_hr' and metric_on = '2024-03-01'
    `;
    check(
      "garmin resting HR persisted",
      restingHr?.value === 51,
      JSON.stringify(restingHr),
    );
  }

  // --- Takeout zip ------------------------------------------------------
  {
    const doc = await documentRow(takeoutId);
    console.log("[e2e] takeout.zip:");
    check(
      "classified takeout_archive",
      doc.document_type === "takeout_archive",
      doc.document_type,
    );
    check(
      "parent completed after children",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    const children = await sql`
      select id, status, original_filename from documents
      where parent_document_id = ${takeoutId}
    `;
    check(
      "one child document (json sidecar skipped)",
      children.length === 1,
      JSON.stringify(children),
    );
    check(
      "child done",
      children[0]?.status === "done",
      JSON.stringify(children[0]),
    );
    const [steps] = await sql`
      select value::float8 as value from daily_metrics
      where source = 'google_fit' and metric = 'steps' and metric_on = '2024-06-01'
    `;
    check(
      "google fit steps persisted (2024-06-01 = 4871)",
      steps?.value === 4871,
      JSON.stringify(steps),
    );
  }

  // --- Apple Health export.xml -----------------------------------------
  {
    const doc = await documentRow(uploads.get("export.xml"));
    console.log("[e2e] export.xml:");
    check(
      "status done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "classified apple_health_export",
      doc.document_type === "apple_health_export",
      doc.document_type,
    );
    const [steps] = await sql`
      select value::float8 as value from daily_metrics
      where source = 'apple_health' and metric = 'steps' and metric_on = '2024-05-01'
    `;
    check(
      "apple steps summed per day (5000+2500)",
      steps?.value === 7500,
      JSON.stringify(steps),
    );
    const workouts = await sql`
      select type from workouts where source = 'apple_health'
    `;
    check(
      "apple workout persisted",
      workouts.length === 1,
      JSON.stringify(workouts),
    );
  }

  // --- Unknown file -----------------------------------------------------
  {
    const doc = await documentRow(uploads.get("unknown.txt"));
    console.log("[e2e] unknown.txt:");
    check("status ignored", doc.status === "ignored", doc.status);
    check(
      "classified unknown",
      doc.document_type === "unknown",
      doc.document_type,
    );
  }

  // --- Scanned lab PDF (vision path) ------------------------------------
  // scanned-lab.pdf is an image-only render of the SAME report as en-cbc.pdf.
  // It is uploaded only after the digital original has settled, so the
  // outcome is deterministic: vision reads the page images (rasterize →
  // ms:// uploads → vision chat), and every extracted row dedups against the
  // (biomarker, date, value) unique index instead of doubling the results.
  {
    const scanUploads = await uploadFiles([
      {
        filename: "scanned-lab.pdf",
        bytes: fixture("scanned-lab.pdf"),
        contentType: "application/pdf",
      },
    ]);
    const scanId = scanUploads.get("scanned-lab.pdf");
    await waitForTerminal([scanId], 240_000);
    const doc = await documentRow(scanId);
    console.log("[e2e] scanned-lab.pdf:");
    check(
      "status done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "classified lab_report",
      doc.document_type === "lab_report",
      doc.document_type,
    );
    check(
      "provider read from the page images",
      doc.provider === "City Central Laboratory",
      String(doc.provider),
    );
    check(
      "document date read from the page images",
      doc.document_date === "2026-03-14",
      String(doc.document_date),
    );
    const [extracting] = await sql`
      select payload from raw_extractions
      where document_id = ${scanId} and stage = 'extracting'
    `;
    check(
      "extraction went through the vision path with a full analyte set",
      extracting?.payload?.vision === true &&
        (extracting?.payload?.extraction?.biomarkers?.length ?? 0) >= 10,
      JSON.stringify({
        vision: extracting?.payload?.vision,
        biomarkers: extracting?.payload?.extraction?.biomarkers?.length,
      }),
    );
    const [{ count: hemoglobinRows }] = await sql`
      select count(*)::int as count
      from biomarker_results r join biomarkers b on b.id = r.biomarker_id
      where b.slug = 'hemoglobin' and r.measured_on = '2026-03-14'
    `;
    check(
      "scan of an already-ingested report dedups (one hemoglobin row)",
      hemoglobinRows === 1,
      `got ${hemoglobinRows}`,
    );
  }
}

async function phaseOutage() {
  console.log("\n[e2e] PHASE 2 — Kimi outage semantics");
  await setOutageMarkers(["outage-lab"]);

  const uploads = await uploadFiles([
    {
      filename: "outage-lab.txt",
      bytes: Buffer.from(OUTAGE_LAB_TXT),
      contentType: "text/plain",
    },
  ]);
  const documentId = uploads.get("outage-lab.txt");
  console.log(
    `[e2e] uploaded outage-lab.txt as ${documentId}; waiting for retry exhaustion`,
  );

  await waitForTerminal([documentId], 300_000);
  {
    const doc = await documentRow(documentId);
    console.log("[e2e] after exhaustion:");
    check("status failed", doc.status === "failed", `got ${doc.status}`);
    check(
      "stage_error kind outage",
      doc.stage_error?.kind === "outage",
      JSON.stringify(doc.stage_error),
    );
    check(
      "outage retries exhausted without burning real attempts",
      doc.stage_error?.outageRetries >= 5 &&
        doc.stage_error?.errorAttempts === 0,
      JSON.stringify(doc.stage_error),
    );
    check(
      "stage_error message is actionable",
      /Kimi API unavailable/.test(doc.stage_error?.message ?? "") &&
        /Retry/.test(doc.stage_error?.message ?? ""),
      doc.stage_error?.message,
    );
    check(
      "every job execution was outage-classed (none burned a real attempt)",
      doc.attempts === doc.stage_error?.outageRetries,
      `attempts ${doc.attempts}, outageRetries ${doc.stage_error?.outageRetries}`,
    );
  }

  // The ingestion health endpoint must surface the failure.
  {
    const response = await fetch(`${WEB_URL}/api/ingestion/health`);
    const health = await response.json();
    console.log("[e2e] /api/ingestion/health:", JSON.stringify(health));
    check("health endpoint ok", response.ok && health.ok === true);
    check(
      "failed count surfaced",
      health.documents?.failed >= 1,
      JSON.stringify(health.documents),
    );
    check(
      "needs_review count surfaced (scanned.pdf)",
      health.documents?.needsReview >= 1,
      JSON.stringify(health.documents),
    );
    check(
      "queue shape present",
      typeof health.queue?.queued === "number" &&
        typeof health.queue?.active === "number",
    );
  }

  console.log("[e2e] restoring connectivity and retrying");
  await setOutageMarkers([]);
  const retryResponse = await fetch(
    `${WEB_URL}/api/documents/${documentId}/retry`,
    {
      method: "POST",
    },
  );
  check(
    "retry endpoint accepted",
    retryResponse.ok,
    String(retryResponse.status),
  );

  await waitForTerminal([documentId], 240_000);
  {
    const doc = await documentRow(documentId);
    console.log("[e2e] after recovery:");
    check(
      "recovered to done",
      doc.status === "done",
      `got ${doc.status} ${JSON.stringify(doc.stage_error)}`,
    );
    check(
      "stage_error cleared",
      doc.stage_error === null,
      JSON.stringify(doc.stage_error),
    );
    const results = await sql`
      select b.slug from biomarker_results r join biomarkers b on b.id = r.biomarker_id
      where r.document_id = ${documentId}
    `;
    check(
      "results persisted after recovery",
      results.length >= 2,
      `got ${results.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[e2e] waiting for the stack");
  await waitFor(
    "web /api/health",
    async () => {
      const response = await fetch(`${WEB_URL}/api/health`);
      return response.ok;
    },
    180_000,
  );
  await waitFor(
    "kimi-mock",
    async () => {
      const response = await fetch(`${KIMI_MOCK_URL}/__mock/mode`);
      return response.ok;
    },
    60_000,
  );
  await setMockMode("ok");
  await setOutageMarkers([]);

  // Make re-runs against the same volumes deterministic: the e2e stack is
  // disposable by definition (README says run it under a dedicated compose
  // project), so clear all pipeline state up front. The biomarker catalog
  // stays — its seed below is an idempotent upsert.
  console.log("[e2e] clearing pipeline state");
  await sql`
    truncate documents, biomarker_results, daily_metrics, workouts,
             ai_insights, raw_extractions restart identity cascade
  `;
  await sql`delete from pgboss.job where name = 'ingest'`.catch(() => {
    // pgboss schema appears with the first boss.start(); nothing to clear.
  });

  console.log("[e2e] seeding the biomarker catalog");
  const seed = spawnSync(
    "node",
    ["--experimental-strip-types", "scripts/seed-biomarkers.mjs"],
    { stdio: "inherit", env: process.env },
  );
  if (seed.status !== 0) {
    throw new Error(`[e2e] biomarker seed failed with status ${seed.status}`);
  }

  await phaseHappyPath();
  await phaseOutage();

  console.log(
    failures === 0
      ? "\n[e2e] PASS — all assertions green"
      : `\n[e2e] FAIL — ${failures} assertion(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error("\n[e2e] FATAL:", error);
    process.exit(1);
  })
  .finally(() => sql.end());
