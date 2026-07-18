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
npm test
```

Other scripts: `npm run lint`, `npm run format`, `npm run build` (produces the standalone
server in `.next/standalone`).

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
- `db` — Postgres 16 (internal only, named volume `pgdata`)
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
