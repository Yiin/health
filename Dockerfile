# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# The worker entry lives outside .next, so standalone tracing skips its
# runtime deps; stage the worker's module closure (from package-lock.json)
# for the runner to copy in one layer. Keep in sync when the worker's
# packages change (pg-boss/postgres, openai + file-type for the classify
# stage, papaparse for wearable CSVs, sax for the Apple Health XML parser,
# unzipper + its dep chain for the Takeout fan-out — its fs-extra is nested
# and rides along with the recursive copy of unzipper itself).
# Scoped names need their parent dir created explicitly.
RUN mkdir -p /worker-modules \
  && for p in pg-boss cron-parser luxon serialize-error non-error type-fest \
    tagged-tag pg pg-connection-string pg-int8 pg-pool pg-protocol pg-types \
    pgpass postgres-array postgres-bytea postgres-date postgres-interval \
    split2 xtend papaparse sax openai \
    file-type strtok3 token-types uint8array-extras @tokenizer/inflate \
    @tokenizer/token @borewit/text-codec ieee754 debug ms \
    unzipper bluebird duplexer2 graceful-fs node-int64 jsonfile universalify \
    inherits readable-stream core-util-is isarray process-nextick-args \
    safe-buffer string_decoder util-deprecate; do \
    mkdir -p "/worker-modules/$(dirname "$p")" \
    && cp -r "node_modules/$p" "/worker-modules/$p"; \
  done

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Same image doubles as the worker: docker run ... node worker/index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
# The worker's classify stage imports app modules (../src/lib/...,
# ../src/db/schema.ts) — node type stripping resolves them from the source
# tree, so the image needs it too.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
# Migration entrypoint (scripts/migrate.mjs) + SQL files. drizzle-orm and
# postgres are zero-dependency packages; standalone tracing skips them
# because no app route imports the db yet, so copy them explicitly.
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps /app/node_modules/postgres ./node_modules/postgres
# Worker queue deps (staged in the deps stage; see comment there).
COPY --from=deps /worker-modules/ ./node_modules/

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
