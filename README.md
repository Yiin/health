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
and use a dedicated `health-test-w4` bucket.

Other scripts: `npm run lint`, `npm run format`, `npm run build` (produces the standalone
server in `.next/standalone`).

## Database

Drizzle ORM + Postgres 16, postgres.js driver. Schema lives in
`src/db/schema.ts`; generated SQL migrations live in `drizzle/` (committed).
`src/db/index.ts` exports a singleton `db` built from `DATABASE_URL`.

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

## Coolify deployment

- Build pack: `dockercompose` — the compose file builds a single image used by both
  `web` (default CMD) and `worker` (command override).
- Set env vars from `.env.example` in Coolify (POSTGRES_PASSWORD, MINIO_ROOT_USER,
  MINIO_ROOT_PASSWORD, MOONSHOT_API_KEY, KIMI_MODEL_CHAT, …). On the VPS also set
  `WEB_PORT=3100` — host port 3000 is already taken by the meals app.
- Exposure is tailnet-only via host Caddy — `web` publishes on loopback
  (`127.0.0.1:${WEB_PORT:-3000}`), which Caddy proxies. `db` and `minio`
  publish loopback-only (`127.0.0.1:${DB_PORT:-5433}` and
  `127.0.0.1:${MINIO_PORT:-9000}`) for host-side tooling/tests — Caddy never
  proxies them.
