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
docker compose up -d db   # required: publishes Postgres on 127.0.0.1:${DB_PORT:-5433}
npm test
```

DB-backed tests use a dedicated `health_test` database, created automatically
by `src/db/test-utils.ts` (migrations in `beforeAll`, table truncation in
`afterEach`) — they never touch dev data. The default connection is
`postgres://postgres:postgres@localhost:5433/health_test`; set
`TEST_DATABASE_URL` if your local port or password differ.

Other scripts: `npm run lint`, `npm run format`, `npm run build` (produces the standalone
server in `.next/standalone`).

## Database

Drizzle ORM + Postgres 16, postgres.js driver. Schema lives in
`src/db/schema.ts`; generated SQL migrations live in `drizzle/` (committed).
`src/db/index.ts` exports a singleton `db` built from `DATABASE_URL`.

- `npm run db:generate` — diff the schema and emit a new migration into `drizzle/`
- `npm run db:migrate` — apply pending migrations (host-side; uses `DATABASE_URL` from `.env`)
- `npm run db:studio` — Drizzle Studio UI

Containers apply migrations automatically at start: `web` and `worker` run
`scripts/migrate.mjs` before booting, and the container refuses to boot if
migrations fail. Concurrent migrators (web + worker starting together) are
serialized with a Postgres advisory lock. The script uses drizzle-orm's
migrator, so the production image needs no dev dependencies.

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
- `minio` — S3-compatible storage (internal only, named volume `miniodata`)
- `bucket-init` — one-shot job that creates the `S3_BUCKET` bucket

`docker compose down -v` tears everything down including volumes.

## Coolify deployment

- Build pack: `dockercompose` — the compose file builds a single image used by both
  `web` (default CMD) and `worker` (command override).
- Set env vars from `.env.example` in Coolify (POSTGRES_PASSWORD, MINIO_ROOT_USER,
  MINIO_ROOT_PASSWORD, MOONSHOT_API_KEY, KIMI_MODEL_CHAT, …). On the VPS also set
  `WEB_PORT=3100` — host port 3000 is already taken by the meals app.
- Exposure is tailnet-only via host Caddy — `web` publishes on loopback
  (`127.0.0.1:${WEB_PORT:-3000}`), which Caddy proxies. `db`/`minio` publish nothing.
