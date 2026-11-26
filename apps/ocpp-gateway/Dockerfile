# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# nd OCPP gateway image. Build from the repository root, which is the build context:
#
#   docker build -f apps/ocpp-gateway/Dockerfile -t nd-ocpp-gateway .
#
# The build stage compiles the workspace and uses `pnpm deploy` to collect the
# gateway with only its production dependencies. The runtime stage is distroless:
# Node.js, CA certificates and nothing else (no shell, no package manager),
# running as a non-root user. Nothing in it is written at runtime, so the
# container can run with a read-only root filesystem.

FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS build
ENV CI=true
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The pnpm version comes from packageManager in package.json (pinned there,
# which hadolint cannot see).
# hadolint ignore=DL3016
RUN npm install --global --no-fund --no-audit "$(node -p 'require("./package.json").packageManager')" \
  && pnpm config set store-dir /pnpm/store --global

# Download every locked package first, so this layer is reused until the lockfile changes.
RUN --mount=type=cache,id=nd-pnpm-store,target=/pnpm/store \
  pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=nd-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline \
  && pnpm --filter "@nd/ocpp-gateway..." run build \
  && pnpm --filter @nd/ocpp-gateway deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a84242e747fbb5aaaa0180c273b6f7130ca34b3300082192ef58eea96089eb3c AS runtime

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="nd-ocpp-gateway" \
  org.opencontainers.image.description="nd OCPP 1.6J central system for chargers" \
  org.opencontainers.image.source="https://github.com/sprintengine/nd" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=9000
WORKDIR /app

# Files stay owned by root and read-only to the nonroot user that runs them.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist

USER 65532:65532
EXPOSE 9000

# Liveness only: /healthz answers while the process runs. /readyz also checks Postgres.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The base image's entrypoint is node, so Node.js is PID 1 and receives
# SIGTERM directly; the app closes its server and pools before exiting.
CMD ["--enable-source-maps", "dist/main.js"]
