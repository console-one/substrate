# Office Space server — Docker image.
#
# Multi-stage: builder installs the full monorepo (devDeps + native-
# addon toolchain for better-sqlite3), then the runtime stage copies
# only the bits a running server needs. The `env docker` subcommand
# configures itself from environment variables — see env/docker.ts
# for the defaults.
#
# Build (from repo root):
#   docker build -f services/office-space/Dockerfile -t office-space .
#
# Run (with a persistent volume):
#   docker run --rm -p 3100:3100 \
#     -v office-space-data:/var/lib/office-space \
#     office-space
#
# Env vars:
#   PORT            Listen port        (default 3100)
#   DB_PATH         SQLite file        (default /var/lib/office-space/contextgraph.db)
#   WORKSPACE_ROOT  fs.* trusted root  (default /var/lib/office-space/workspace)

# ─── Builder stage ──────────────────────────────────────────────
# Alpine + build-base + python3 covers better-sqlite3's native
# addon build path (prebuild-install fetches a binary when
# available, otherwise node-gyp compiles from source).
FROM node:20-alpine AS builder
WORKDIR /build
RUN apk add --no-cache build-base python3

# Copy monorepo manifests first so the npm ci layer caches when
# only source changes — stock Docker-layering hygiene. (packages/stdlib
# is a .ft asset bundle with no package.json, so it's not a workspace
# target — just copied verbatim below.)
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY services/office-space/package.json services/office-space/

RUN npm ci --workspaces --include-workspace-root

# Now bring in the source and compile the two workspaces we need.
COPY packages/core ./packages/core
COPY packages/stdlib ./packages/stdlib
COPY services/office-space ./services/office-space

RUN npm run build --workspace @ft/core
RUN npm run build --workspace @ft/office-space

# ─── Runtime stage ──────────────────────────────────────────────
# Slim image: only what's needed to run the compiled JS plus
# better-sqlite3's native binding.
FROM node:20-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime on alpine even though
# build tooling is gone.
RUN apk add --no-cache libstdc++

COPY --from=builder /build/package.json /build/package-lock.json* ./
COPY --from=builder /build/packages/core/package.json ./packages/core/
COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/stdlib ./packages/stdlib
COPY --from=builder /build/services/office-space/package.json ./services/office-space/
COPY --from=builder /build/services/office-space/dist ./services/office-space/dist
COPY --from=builder /build/services/office-space/src/bootstrap.ft ./services/office-space/src/bootstrap.ft
COPY --from=builder /build/services/office-space/src/ui.html ./services/office-space/src/ui.html

RUN npm ci --workspaces --include-workspace-root --omit=dev

# Persistent state goes on a Docker volume mounted here.
RUN mkdir -p /var/lib/office-space/workspace
VOLUME ["/var/lib/office-space"]

ENV PORT=3100
ENV DB_PATH=/var/lib/office-space/contextgraph.db
ENV WORKSPACE_ROOT=/var/lib/office-space/workspace

EXPOSE 3100

# Prod runs compiled dist directly — no tsx shim, no on-the-fly
# transpile. The dev `bin/office-space.cjs` launcher goes through
# tsx for hot-edit ergonomics; that's the wrong call for a
# production container.
WORKDIR /app/services/office-space
CMD ["node", "dist/index.js", "env", "docker"]
