# Scanning worker.
#
# This container handles hostile input for a living, so it is built to own as
# little as possible: no shell is invoked to run a scan, no compiler or package
# manager survives into the runtime image, the process runs as a non-root user
# it does not own the files of, and the filesystem is read-only apart from one
# explicitly mounted scratch directory.
#
# Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t mcp-upgrade-worker .

# ---------------------------------------------------------------------------
# Stage 1 — install and build
# ---------------------------------------------------------------------------
FROM node:22.20.0-bookworm-slim AS build

WORKDIR /build

# Manifests first, so a dependency install is cached independently of source.
COPY package.json package-lock.json ./
COPY packages/scanner/package.json packages/scanner/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/worker/package.json apps/worker/
# The web workspace is declared in the root manifest, so npm needs its manifest
# present to resolve the workspace graph even though it is never built here.
COPY apps/web/package.json apps/web/

# `--ignore-scripts` keeps dependency lifecycle scripts from running during the
# image build. The workspace packages are built explicitly below instead.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/scanner packages/scanner
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/worker apps/worker

RUN npm run build --workspace @mcp-upgrade/shared \
 && npm run build --workspace mcp-upgrade \
 && npm run build --workspace @mcp-upgrade/database \
 && npm run build --workspace @mcp-upgrade/worker

# Re-install without dev dependencies so no compiler, test runner or linter is
# carried into the runtime image.
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SCAN_TEMP_ROOT=/scans \
    WORKER_PORT=8080 \
    # A hostile repository is mostly a parsing workload; capping the heap turns
    # a memory blow-up into a crash the platform restarts rather than an OOM
    # that takes the host with it.
    NODE_OPTIONS=--max-old-space-size=1024

WORKDIR /app

# Only the built output and production dependencies. No source, no tests, no
# fixtures — the hostile-archive fixtures in particular have no business
# existing in a production image.
COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/package.json ./package.json
COPY --from=build --chown=root:root /build/packages/scanner/dist ./packages/scanner/dist
COPY --from=build --chown=root:root /build/packages/scanner/package.json ./packages/scanner/package.json
COPY --from=build --chown=root:root /build/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=root:root /build/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=root:root /build/packages/database/dist ./packages/database/dist
COPY --from=build --chown=root:root /build/packages/database/migrations ./packages/database/migrations
COPY --from=build --chown=root:root /build/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=root:root /build/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=root:root /build/apps/worker/package.json ./apps/worker/package.json

# The scratch directory is the only thing the worker may write to, and it is the
# only path it owns. Everything else stays owned by root so the runtime user
# cannot modify its own code.
RUN mkdir -p /scans && chown node:node /scans && chmod 700 /scans

# `node` is an unprivileged user that ships with the base image.
USER node

EXPOSE 8080

# Liveness only. The authenticated /status endpoint is not used here because a
# health check should not need to hold a secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node is PID 1 and receives SIGTERM directly, which is what the
# graceful shutdown in main.ts depends on. No shell is involved.
CMD ["node", "apps/worker/dist/main.js"]
