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

# Sources are copied before the install rather than after.
#
# The tempting arrangement is manifests first, `npm ci`, then sources, so a
# dependency layer caches independently. It does not work here: the scanner
# workspace declares a `prepare` script, npm runs it during install, and
# `--ignore-scripts` did not suppress it for a workspace — so the build failed
# on a tsconfig that had not been copied yet. Copying first makes the install
# correct regardless of how npm treats lifecycle scripts, at the cost of
# invalidating the dependency layer when a source file changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
# The web workspace is declared in the root manifest, so npm needs its manifest
# present to resolve the workspace graph even though it is never built here.
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts

RUN npm run build --workspace @mcp-upgrade/shared \
 && npm run build --workspace mcp-upgrade \
 && npm run build --workspace @mcp-upgrade/database \
 && npm run build --workspace @mcp-upgrade/worker

# Prune rather than reinstall: the built output stays in place and no lifecycle
# script runs a second time. What leaves is every linter and test runner, none
# of which belongs in a container that unpacks hostile archives.
#
# Pruning is not sufficient on its own. `apps/web` is a workspace, so npm
# installs *its* production dependencies too — Next.js, React, Stripe and the
# image toolchain — none of which the worker imports. They are removed
# explicitly. This list is deterministic and is asserted by CI, so a new web
# dependency that lands here fails the build rather than quietly adding several
# hundred megabytes of unreviewed code to a container that handles hostile
# input.
#
# TypeScript deliberately stays: the scanner uses the TypeScript compiler API to
# parse source, so it is a runtime dependency rather than build tooling.
RUN npm prune --omit=dev --ignore-scripts \
 && rm -rf \
      node_modules/next \
      node_modules/@next \
      node_modules/react \
      node_modules/react-dom \
      node_modules/scheduler \
      node_modules/stripe \
      node_modules/sharp \
      node_modules/@img \
      node_modules/@supabase/ssr \
      node_modules/playwright-core \
      node_modules/@playwright \
      node_modules/.bin/next \
      node_modules/.bin/playwright \
      node_modules/.bin/vitest \
      node_modules/.bin/eslint

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
#
# Note for whoever deploys this: mounting a volume or tmpfs at /scans *replaces*
# this directory, and the mount arrives owned by root regardless of what is set
# here. The mount must therefore carry uid=1000,gid=1000 (the `node` user) or
# every scan fails with EACCES on its first mkdtemp. docker-compose.yml does
# this; a platform-managed mount needs the same.
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
