# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
# The worker entry lives outside .next, so standalone tracing skips its
# runtime deps; stage the worker's module closure (from package-lock.json)
# for the runner to copy in one layer. Keep in sync when the worker's
# packages change (pg-boss/postgres, openai + file-type for the classify
# stage, papaparse for wearable CSVs, sax for the Apple Health XML parser,
# unpdf + zod for lab extraction/normalize, unzipper + its dep chain for
# the Takeout fan-out — its fs-extra is nested and rides along with the
# recursive copy of unzipper itself, @lhncbc/ucum-lhc + its chain for the
# canonical-unit conversion inside normalize's insertResults, @aws-sdk/*
# + @smithy/* for src/lib/storage.ts which classify/extract/takeout import).
# The e2e stack (npm run e2e) boots this worker for real — run it after
# changing worker imports; a missing package fails the worker at startup.
# Scoped names need their parent dir created explicitly.
RUN mkdir -p /worker-modules \
  && for p in pg-boss cron-parser luxon serialize-error non-error type-fest \
    tagged-tag pg pg-connection-string pg-int8 pg-pool pg-protocol pg-types \
    pgpass postgres-array postgres-bytea postgres-date postgres-interval \
    split2 xtend papaparse sax openai \
    file-type strtok3 token-types uint8array-extras @tokenizer/inflate \
    @tokenizer/token @borewit/text-codec ieee754 debug ms \
    unpdf zod \
    unzipper bluebird duplexer2 graceful-fs node-int64 jsonfile universalify \
    inherits readable-stream core-util-is isarray process-nextick-args \
    safe-buffer string_decoder util-deprecate \
    @lhncbc/ucum-lhc coffeescript csv-parse csv-stringify lodash.get \
    escape-html is-integer is-finite stream-transform string-to-stream \
    xmldoc \
    @aws-sdk/checksums @aws-sdk/client-s3 @aws-sdk/core \
    @aws-sdk/credential-provider-env @aws-sdk/credential-provider-http \
    @aws-sdk/credential-provider-ini @aws-sdk/credential-provider-login \
    @aws-sdk/credential-provider-node @aws-sdk/credential-provider-process \
    @aws-sdk/credential-provider-sso @aws-sdk/credential-provider-web-identity \
    @aws-sdk/lib-storage @aws-sdk/middleware-sdk-s3 @aws-sdk/nested-clients \
    @aws-sdk/signature-v4-multi-region @aws-sdk/token-providers \
    @aws-sdk/types @aws-sdk/xml-builder @aws/lambda-invoke-store \
    @smithy/core @smithy/credential-provider-imds @smithy/fetch-http-handler \
    @smithy/node-http-handler @smithy/signature-v4 @smithy/types \
    base64-js bowser buffer events stream-browserify tslib; do \
    mkdir -p "/worker-modules/$(dirname "$p")" \
    && cp -r "node_modules/$p" "/worker-modules/$p"; \
  done

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# poppler-utils (pdfinfo + pdftoppm, ~5 MB) rasterizes scanned PDFs for the
# worker's vision extraction path (worker/vision.ts). Chosen over rendering
# through pdfjs + @napi-rs/canvas: an order of magnitude slimmer than the
# skia native module, no npm dependency, and the reference renderer copes
# with PDFs pdfjs chokes on — exactly the population that lands in vision.
RUN apk add --no-cache poppler-utils

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
