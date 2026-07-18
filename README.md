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
(same image as web). Each `ingest` job walks its document through
classifying → extracting → normalizing → done (`worker/ingestion.ts`),
resuming from persisted state: every finished stage caches its payload in
`raw_extractions` (unique per document+stage), so a retried job never
re-runs a completed stage, and `documents.status` marks the stage in flight.
A stage error records `stage_error {stage, message, at}` and rethrows for
pg-boss to retry; the final attempt lands the document in `failed` instead.
Stage implementations are stubs for now. SIGTERM stops fetching and lets the
active job finish (60s grace, then pg-boss requeues it for the next worker).

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
