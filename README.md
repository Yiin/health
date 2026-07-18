# health

Health dashboard — Next.js (App Router, TypeScript, Tailwind, shadcn/ui, dark-first) with a
companion worker process. Postgres + MinIO run alongside via Docker Compose.

## Dev setup

```bash
npm install
npm run dev
```

## Tests

```bash
docker compose up -d db minio   # required for the DB and storage integration tests
npm test
```

DB-backed tests use a dedicated `health_test` database, created automatically
by `src/db/test-utils.ts` (migrations in `beforeAll`, table truncation in
`afterEach`) — they never touch dev data. The default connection is
`postgres://postgres:postgres@localhost:5433/health_test`; set
`TEST_DATABASE_URL` if your local port or password differ.

Storage tests read MinIO credentials from `.env` and skip cleanly when it is
absent. They run against the host-published port (`MINIO_PORT`, default 9000)
and use a dedicated bucket (`MINIO_TEST_BUCKET`, default `health-test-w4`).

Other scripts: `npm run lint`, `npm run format`, `npm run build` (produces the standalone
server in `.next/standalone`).

## Database

Drizzle ORM + Postgres 16, postgres.js driver. Schema lives in
`src/db/schema.ts`; generated SQL migrations live in `drizzle/` (committed).
`src/db/index.ts` lazily builds the singleton from `DATABASE_URL` — import
the `db` proxy directly, or use `getDb()` / `getSqlClient()` for explicit
access — so importing route modules never connects at build time.

- `npm run db:generate` — diff the schema and emit a new migration into `drizzle/`
- `npm run db:migrate` — apply pending migrations (host-side; uses `DATABASE_URL` from `.env`)
- `npm run db:seed` — upsert the biomarker catalog (`src/db/seed/biomarkers.ts`,
  ~40 analytes with EN+LT aliases and UCUM canonical units) into `biomarkers`;
  idempotent on slug, safe to re-run
- `npm run db:studio` — Drizzle Studio UI

Domain modules: `src/lib/units.ts` normalizes as-reported unit strings to UCUM
and converts values into each biomarker's canonical unit (ucum-lhc for
commensurable units, the biomarker's molar mass for mol<->mass; `null` when no
conversion path exists — never guessed). `src/db/repos/biomarker-results.ts`
holds the results repository (deduping insert, trend series, latest-result
join) as pure functions taking the drizzle db as their first argument.

Containers apply migrations automatically at start: `web` and `worker` run
`scripts/migrate.mjs` before booting, and the container refuses to boot if
migrations fail. Concurrent migrators (web + worker starting together) are
serialized with a Postgres advisory lock. The script uses drizzle-orm's
migrator, so the production image needs no dev dependencies.

## File storage

Originals live in MinIO (S3) at content-addressed keys
`originals/<yyyy>/<mm>/<sha256[:2]>/<sha256>` (`src/lib/storage.ts`), so dedup
is structural: re-uploading identical bytes is a no-op. v1 has **no
browser-presigned URLs** — MinIO sits on a Docker-internal hostname that
tailnet browsers cannot reach, so all uploads and downloads proxy through
Next.js route handlers with streaming (`GET /api/files/[documentId]`), never
buffering a whole file in memory.

Per-file cap is **2 GB** (enforced by the upload route). Split Google Takeout
exports into <=2 GB parts at export time.

## Uploads & ingestion

`POST /api/uploads` accepts multipart file(s) — pdf, csv, xml, zip, png, jpg,
webp, txt, json — and processes each independently: bytes stream through a
SHA-256 hash into content-addressed storage (never buffered in memory), the
document row and its `ingest` job commit in one transaction
(`src/lib/uploads.ts`), and identical bytes short-circuit as duplicates with
no new job. `POST /api/documents/[id]/retry` resets a failed/needs_review
document (attempts preserved) and re-enqueues it; an optional JSON body
`{ "documentType": "…" }` ("Process as…") stores the type hint as a metadata
override in the same transaction, so the classifier sees it on the re-run.
`POST /api/documents/[id]/reprocess` is the done-document counterpart: it
deletes the document's `raw_extractions` stage cache first (so every stage
re-runs against the current implementation instead of resuming from stale
cached output — the recovery for documents processed while stages were
stubs), then resets to `uploaded` and re-enqueues like retry. The detail
page surfaces it as a Reprocess button next to the download action.

`/upload` is the drop-anything dropzone (drag-drop or click, per-file XHR
progress) with a live ingestion feed underneath: it polls
`GET /api/documents?status=active` every 3 s while any document is
non-terminal (the response's `hasActive` flag drives the polling), renders
each document's stage stepper and the classifier's verdict once known, and
offers Retry / "Process as…" recovery for failed/needs_review documents. A
condensed version of the same feed (`IngestionStatusStrip`) sits on the
overview page. The DB only persists the current status, so per-stage
timestamps are observed client-side at poll granularity
(`src/lib/ingestion-feed.ts`).

Background jobs use pg-boss on the app Postgres (no Redis): `src/lib/queue.ts`
holds the shared boss instance used by both the web enqueue path and the
worker. The `ingest` queue uses the exclusive policy, so the singleton key
(the file's sha256) suppresses a second job while one is still pending or
running; jobs retry 3 times with backoff and expire after 15 min per attempt.

The worker container runs `node --experimental-strip-types worker/index.mjs`
(same image as web). Each `ingest` job walks its document through the state
machine in `worker/ingestion.ts`:

```
                        ┌────────────────────────────────────────────────┐
                        │                the happy path                  │
uploaded → classifying → extracting → normalizing → summarizing → done
   ▲          │              │            │             │
   │          │  halt marker (scanned PDF, low classifier confidence,
   │          │  validation sweep failure, unparseable wearable CSV, …)
   │          └──────────────┴─────┬──────┴─────────────┘
   │                               ▼
   │                    needs_review   or   ignored  (unknown documents)
   │                               │
   │        POST /api/documents/[id]/retry  (optional "Process as…" hint)
   └───────────────────────────────┘

any stage ── error, real attempts exhausted (3) ──────────────→ failed
any stage ── Kimi outage, outage retries exhausted (5) ───────→ failed
   (failed also recovers through the retry endpoint, back to uploaded)
```

The pipeline resumes from persisted state: every finished stage caches its
payload in `raw_extractions` (unique per document+stage), so a retried job
never re-runs a completed stage, and `documents.status` marks the stage in
flight. A stage may halt the run in a terminal status
(`needs_review`/`ignored`) via a `halt` marker on its cached payload. A
Takeout parent additionally *parks* at `normalizing` (no job scheduled) until
its child documents all turn terminal. SIGTERM stops fetching and lets the
active job finish (60s grace, then pg-boss requeues it for the next worker).

### Retry semantics

Two failure classes exist, with separate budgets (`worker/ingestion.ts`;
counters live in `documents.stage_error`, so they survive worker restarts):

- **Real errors** (a bug, bad input, a non-retryable Kimi reply): each failing
  execution records `stage_error {stage, message, at, kind: "error"}` and
  rethrows so pg-boss retries with exponential backoff (30s doubling, 10 min
  cap). The **3rd** real failure (`MAX_ATTEMPTS`) lands the document in
  `failed`.
- **Kimi outages** (5xx, 429, timeouts, connection failures —
  `KimiError.retryable`): first retried *inside* the call by
  `src/lib/kimi/client.ts` (3 attempts, exponential backoff, Retry-After
  aware). If the call still fails, the execution records
  `stage_error {kind: "outage"}` and rethrows for the same pg-boss backoff —
  but increments only the **outage** counter, so an outage never burns the
  document's real attempts. After **5** outage-classed executions
  (`OUTAGE_RETRY_LIMIT`) the document fails with an actionable
  `stage_error.message` (what was down, that no real attempts were consumed,
  and to use Retry once connectivity is back).

The pg-boss job is sent with `retryLimit = 7` (`MAX_JOB_EXECUTIONS - 1`
in `src/lib/queue.ts`), covering the worst case of 3 real + 5 outage
executions; the executor force-fails the document if pg-boss ever runs out of
executions first, so nothing strands mid-pipeline. Counters reset whenever
the pipeline reaches a new stage, and when the retry endpoint clears
`stage_error`.

After connectivity is restored, `POST /api/documents/[id]/retry` resets the
document to `uploaded` and re-enqueues it; completed stages replay from the
`raw_extractions` cache, so recovery re-runs only what never finished.

### Ingestion health

`GET /api/ingestion/health` returns the pipeline snapshot
(`src/lib/ingestion-health.ts`):

```json
{
  "ok": true,
  "queue": { "queued": 0, "active": 1 },
  "documents": { "processing": 1, "failed": 0, "needsReview": 2 }
}
```

`queue` is the pg-boss `ingest` queue depth (`created`+`retry` = queued,
`active` = running) read straight from `pgboss.job`; `documents` counts every
document by pipeline state. The upload page shows the same numbers as a
status strip. The endpoint sits behind the basic-auth gate like the rest of
the API (only `/api/health` is exempt).

The classifying stage (`worker/classify.ts`) is real. Classification is
two-layer: a deterministic layer
(magic bytes via file-type, zip listing markers for Takeout / Apple Health /
Garmin DI_CONNECT, wearable CSV header shapes) decides without an LLM, and
only ambiguous containers (PDF, other text) fall back to a Kimi
`chatStructured` verdict `{docType, language, confidence, summary}`
(EN+LT system prompt, `CLASSIFY_PROMPT_V1`). Confidence < 0.6 halts the
pipeline in `needs_review` (recover via the retry endpoint's "Process as…"
hint, stored as a metadata override the classifier honors); `unknown` halts
in `ignored` — terminal, stored and searchable, never blocking the queue.
Verdicts persist `document_type`, `classification_confidence` and
`ai_summary`, and the cached payload can carry a `halt` marker the executor
turns into those terminal statuses.

The extracting stage (`worker/extract.ts`) dispatches on `document_type`. For
`apple_health_export` it streams the XML through a SAX parser
(`worker/apple-health/` — the whole file is never loaded): `<Record>` elements
aggregate onto `daily_metrics` per device-local day (steps summed; resting HR /
HRV / weight averaged; SleepAnalysis categories become sleep-stage minutes
attributed to the wake day — plain HeartRate is deliberately unmapped, it is
not resting HR) and `<Workout>` elements land in `workouts` with the original
element kept in `raw`. Writes are batched upserts / insert-or-skips, so a
mid-parse crash resumes duplicate-free; a
`raw_extractions('apple_health_progress')` checkpoint row tracks flushed counts
after every batch. Apple's `export.zip` container itself halts in
`needs_review` until archive walking lands. For `lab_report` documents,
extraction reads the text layer with unpdf (below ~100 chars the PDF is
scanned → `needs_review`, vision path pending), then runs Kimi structured
output: k2.6 → one retry with the zod error appended → escalation to the
expert model (k3) on persistent validation failure or an implausibly small
analyte count; a full sweep of failures lands in `needs_review` with
`stage_error`. The normalizing stage (`worker/normalize.ts`) maps analyte
names onto the biomarkers catalog (exact alias → fuzzy → batched LLM mapping,
with confirmed LLM mappings written back into `biomarkers.aliases`) and
persists via `insertResults` (canonical-unit conversion + dedup built in).
Schemas live in `src/lib/ingest/schemas.ts`, name matching in
`src/lib/ingest/mapping.ts`; synthetic EN+LT PDF fixtures live in
`fixtures/health-docs/` (regenerate with `node fixtures/health-docs/generate.mjs`).

The final summarizing stage (`worker/summarize.ts`) runs for every document
that reaches it: one Kimi call writes the 2-4 sentence `documents.ai_summary`
(in the document's language or English; text-less exports are summarized from
a digest of their pipeline payloads) that feeds the library's full-text
search, replacing the classifier's provisional 1-2 sentence guess. For
`lab_report` documents it then files ONE `ai_insights` row (kind
`post_ingestion`, prompt version `INSIGHT_PROMPT_V1`): a second Kimi call
compares the newly persisted results against history (`getTrend`) and the
row's `source_refs` point at the document plus its `biomarker_results` rows so
the UI can link out. An existing insight for the document makes the insert a
no-op, so a retried stage never doubles it; wearable/activity documents get
no insight in v1.

### Live Kimi smoke eval

`scripts/kimi-smoke.ts` ingests the synthetic samples in
`fixtures/health-docs/` (LT + EN lab PDFs, wearable CSV, scanned PDF) through
the real classify/extract/normalize stages against the **live** Kimi API and
prints classification, extracted records vs ground truth, token cost, and
latency. Manual runs only (the API costs money); see `docs/kimi-eval.md` for
the runbook and the 2026-07-18 findings (LT extraction excellent; scanned
image-only PDFs need the vision fallback; Tier0 queue copes).

### E2E pipeline test

One command runs the whole stack — web, worker, Postgres, MinIO — with only
the Moonshot API swapped for a deterministic mock (`scripts/kimi-mock.mjs`),
uploads one fixture of every supported shape through the real upload route,
and asserts the final database state per document:

```bash
npm run e2e     # docker compose -p health-e2e -f docker-compose.yml \
                #   -f docker-compose.e2e.yml run --build --rm e2e
npm run e2e:down   # tear the e2e stack down, volumes included
```

Coverage (`scripts/e2e-pipeline.mjs`): EN + LT lab PDFs land `done` with
mapped `biomarker_results` (decimal commas and LT aliases included); a
scanned PDF halts in `needs_review` with a stage_error naming the scan; a
Garmin CSV and an Apple Health `export.xml` land their `daily_metrics` /
`workouts`; a Takeout zip fans out a Google Fit child document and the parent
completes behind the barrier; an unrelated text file is `ignored`. A second
phase flips the mock into outage mode (every request 503s) and proves the
retry semantics above end-to-end: exhaustion → `failed` with an actionable
outage `stage_error` and zero real attempts consumed, then restored
connectivity + the retry endpoint → `done` with results.

The overlay (`docker-compose.e2e.yml`) publishes no host ports and runs under
its own compose project, so it never collides with a dev stack. It reads
passwords from the same `.env` as regular compose (any values work). The
worker runs with `INGEST_RETRY_DELAY_S=1` there so the outage phase finishes
in seconds; production keeps the 30s backoff base.

## Documents library

`/documents` lists every uploaded file as cards (AI summary, type/provider,
document date, ingestion status) with a full-text search box (tsvector over
extracted text + summaries, `ts_headline` snippets) and type/provider filters
— all server-rendered via query params. `/documents/[id]` shows the full
summary, biomarkers extracted from the document (once the labs domain lands),
provenance with a download link (`/api/files/[id]`), a source excerpt, and
inline-editable metadata.

Metadata edits (type, provider, date) go to `PATCH /api/documents/[id]` and
are stored in the `metadata_overrides` jsonb column — never in the
pipeline-extracted columns — so re-running ingestion never clobbers manual
edits. The UI displays effective values (override wins; an explicit null
means "cleared") and marks edited documents with an "edited" badge.

## AI chat

`/chat` is a conversational interface over the user's own data. `POST
/api/chat` runs one turn: Kimi (kimi-k2.6) with OpenAI-compatible tool
calling — `search_documents`, `get_biomarker_trend`, `get_daily_metrics`,
`get_document` (`src/lib/chat/tools.ts`) — and streams progress as SSE events
(`conversation` → `tool` → `citations` → `delta` chunks → `done`). The system
prompt restricts answers to health questions and requires grounding in tool
results; the UI renders each cited source as a quoted passage linking to
`/documents/[id]` (the trust pattern: the quote is what the answer was built
from).

Conversations persist in `conversations` + `messages` (tool rounds and
citations as jsonb, `reasoning_content` per assistant message — Kimi thinking
models require it echoed back in multi-turn histories). The sidebar lists
conversations with title search and archive (`PATCH
/api/chat/conversations/[id]`).

## Overview, insights & flags

`/` (the overview) is server-rendered from the DB: stat cards for the latest
key vitals (steps, resting HR, HRV, sleep, weight — newest day per metric via
`getLatestMetricValues`) plus the biomarker in-range ratio; a "needs
attention" strip (biomarkers whose latest draw is flagged + failed /
needs-review documents); the three most recent AI insights; and the five most
recent uploads. `/insights` shows deterministic flag cards followed by the
full `ai_insights` feed (kind badge, markdown body, date, and source links
resolved from `source_refs` — `document` → `/documents/[id]`, `biomarker` →
`/labs/[slug]`, `biomarker_result` → the slug in its `note`).

The flags come from a deterministic, LLM-free engine (`src/lib/flags.ts`):
out-of-range vs the draw's reference range, a big delta vs the previous draw
(25% default, configurable), and a trend reversal (the latest move against an
established 3+-draw trend). The same flags render as `callouts` on the labs
detail `TrendChart` — dashed vertical markers at the flagged draws.

## Basic-auth gate

The app sits behind a drive-by HTTP basic-auth gate (`src/proxy.ts`).
Tailscale already restricts network access to the tailnet, so this is **not
real auth** — just a barrier against casual browsers on shared tailnet
devices.

- Set both `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` to enable it: every page
  and API route then requires the credentials (401 + `WWW-Authenticate`
  otherwise).
- Leave either unset (the default) and all requests pass through.
- `/api/health` is exempt so Docker/Coolify healthchecks keep working.
- `/api/uploads` is exempt from the proxy because a matched proxy buffers the
  request body (10MB default), truncating multi-GB streams; the route
  enforces the same check itself.

## Docker Compose

```bash
cp .env.example .env   # fill in passwords / keys
docker compose up -d --build
```

Services:

- `web` — Next.js standalone server on `http://localhost:3000` (`/api/health` returns `{"ok":true}`)
- `worker` — same image, `node worker/index.mjs`, no ports
- `db` — Postgres 16 (named volume `pgdata`; published on loopback
  `127.0.0.1:${DB_PORT:-5433}` for host-side tooling, unreachable off-host)
- `minio` — S3-compatible storage (loopback-only publish on `127.0.0.1:${MINIO_PORT:-9000}` for host-side tests, named volume `miniodata`)
- `bucket-init` — one-shot job that creates the `S3_BUCKET` bucket

`docker compose down -v` tears everything down including volumes.

## Deployment & ops

Deploys run on the yiin.lt VPS via Coolify (dockercompose build pack; app
`health`, uuid `sm0pz5crgs0hni4qzxwqxuw0`, project `zscg4kw848www4k44g4okgg4`,
server `tw8so8o8sc0w8ssw80kco8c8`). The compose file builds a single image
used by both `web` (default CMD) and `worker` (command override); a push to
`main` triggers a deploy through the webhook workflow in
`.github/workflows/deploy.yml`.

### Environment variable reference

| Variable | Used by | Meaning |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | db, web, worker | Postgres superuser password (compose wires it into `DATABASE_URL`). |
| `POSTGRES_DB` | db | Database name; default `health`. Applied only on a fresh volume. |
| `DATABASE_URL` | host tooling | Host-side URL for `next dev`, drizzle-kit, and scripts; containers get the internal `…@db:5432` URL from compose. |
| `DB_PORT` | compose | Host loopback port for the db publish; default 5433. VPS: 5433. |
| `WEB_PORT` | compose | Host loopback port for the web publish; default 3000. **VPS: 3100** (meals owns 3000). |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | minio, web, worker | MinIO root credentials; compose reuses them as the app's S3 keys. |
| `MINIO_PORT` | compose | Host loopback port for the MinIO publish; default 9000. **VPS: 9080** (ClickHouse owns 9000). |
| `S3_ENDPOINT` | web, worker | S3 endpoint; `http://minio:9000` in compose. |
| `S3_BUCKET` | web, worker, bucket-init | Bucket for originals; default `health`. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | web, worker | S3 credentials (compose injects the MinIO root pair). Also read by the storage integration tests. |
| `MOONSHOT_API_KEY` | web, worker | Kimi API key. From the local token store (`get-token MOONSHOT_API_KEY`); never committed. |
| `MOONSHOT_BASE_URL` | web, worker | Kimi API base URL override. Unset in production; the e2e stack points it at kimi-mock. |
| `KIMI_MODEL_CHAT` | web, worker | Standard pipeline model id; default `kimi-k2.6` (expert stays `kimi-k3`). |
| `INGEST_RETRY_DELAY_S` | worker, web | Base pg-boss retry delay (seconds, doubling; default 30). Test-only knob — e2e sets 1. |
| `UPLOAD_MAX_BYTES` | web | Per-file upload cap; default 2 GiB. Lower only for tests. |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | web | Optional drive-by basic-auth gate; both set = on. |
| `TEST_DATABASE_URL` | vitest | DB-test override; default `postgres://postgres:postgres@localhost:5433/health_test`. |
| `MINIO_TEST_BUCKET` | vitest | Storage-test bucket; default `health-test-w4`. |

### Required Coolify env vars

Set everything from `.env.example` (`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD`, `MOONSHOT_API_KEY`, `KIMI_MODEL_CHAT`, …), plus these
two VPS-specific port overrides. Both are **required** — a rebuilt Coolify
app without them silently regresses:

- `WEB_PORT=3100` — host port 3000 belongs to the meals app (meals.yiin.lt).
- `MINIO_PORT=9080` — host port 9000 belongs to an unrelated ClickHouse
  container. Shipping the 9000 default makes `docker compose up` die on the
  port collision, which takes `web`/`worker` down (incident 2026-07-18:
  every deploy from 13:05 to 15:36 UTC failed this way).

### Port layout (all loopback-only on the host)

- `127.0.0.1:3100` → `web` — the only service Caddy proxies
- `127.0.0.1:9080` → `minio` — host-side tooling/tests only
- `127.0.0.1:5433` → `db` — host-side tooling only

### Exposure: tailnet-only

The VPS runs a custom Caddy with the caddy-tailscale plugin:

```
health.yiin.lt {
  bind tailscale/health
  tls { dns digitalocean {env.DIGITALOCEAN_API_TOKEN} }
  reverse_proxy localhost:3100
}
```

The site binds **only** the tailnet node `health` (100.66.69.34). The public
Caddy fallback explicitly excludes `health.yiin.lt`, so over the public
internet the domain answers an **empty 200 on purpose** — that is the design,
not a bug; never point public Caddy at the app. Name resolution for tailnet
clients is split-DNS managed by the user outside this repo: never create
public DNS records for `health.yiin.lt` and never change the Caddyfile from
app work.

### Post-deploy verification

A plain HTTP 200 proves nothing here: with the app down, Caddy still answers
an (empty) 200. After every deploy — or whenever the site looks off — run
from the VPS (or any tailnet client):

```bash
scripts/verify-deploy.sh        # or: npm run verify:deploy
```

It curls `https://health.yiin.lt/` pinned to the tailnet IP
(`curl --resolve health.yiin.lt:443:100.66.69.34`) and fails unless the
response is a 200 with a **non-empty** body containing `<html` — exactly the
empty-200 failure mode a status-only check misses. If the basic-auth gate is
enabled on the deployment, export `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` first.
On failure, check the app directly on the VPS
(`curl -sS http://127.0.0.1:3100/api/health`, expect `{"ok":true}`), then
`docker ps` and the Coolify deployment logs.

### Runbook

All commands run on the VPS from the app's compose directory (Coolify keeps
it under `/data/coolify/applications/<uuid>`); `docker compose ps` shows the
service names.

**Is the pipeline healthy?**

```bash
curl -sS -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  http://127.0.0.1:3100/api/ingestion/health
```

A deep `queue.queued` that never drains means the worker is down or stuck;
growing `documents.failed` means ingestions are exhausting their retries —
read the per-document `stage_error` to see which stage and why:

```bash
docker compose exec db psql -U postgres health -c \
  "select id, original_filename, status, attempts,
          stage_error->>'stage' as stage, stage_error->>'kind' as kind,
          stage_error->>'message' as message
   from documents where status in ('failed','needs_review')
   order by uploaded_at desc limit 20"
```

**Restart the worker** (job mid-flight is safe: SIGTERM lets it finish, and
a killed job resumes from the stage cache):

```bash
docker compose restart worker
docker compose logs -f --tail 50 worker
```

**Re-drive failures.** `stage_error.kind` tells you which lever to pull:

- `outage` — Kimi was unreachable; no real attempts were consumed. Confirm
  connectivity is back (Moonshot status, `MOONSHOT_API_KEY`,
  `MOONSHOT_BASE_URL` unset), then re-enqueue — completed stages replay from
  cache:

  ```bash
  curl -sS -X POST -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
    http://127.0.0.1:3100/api/documents/<id>/retry
  ```

- `error` — the pipeline hit a real problem three times; retrying without a
  change usually fails again. Fix the cause (or pick a type via the UI's
  "Process as…" — a retry with `{"documentType":"…"}` in the body), then
  retry. For documents that finished `done` against old stage code, `POST
  /api/documents/<id>/reprocess` clears the stage cache and re-runs
  everything.

- `needs_review` documents are a product state, not an incident: review in
  the UI, then Retry / "Process as…".

**Queue surgery** (rare). Inspect and clear pg-boss jobs directly:

```bash
docker compose exec db psql -U postgres health -c \
  "select id, state, retry_count, start_after from pgboss.job
   where name = 'ingest' order by created_on desc limit 20"
```

Deleting a job row while its document is non-terminal strands the document —
prefer the retry endpoint, which resets the document AND enqueues a fresh
job in one transaction.

**Full-stack check before/after risky changes:** `npm run e2e` (see "E2E
pipeline test") runs the entire ingestion surface against the mock locally.
