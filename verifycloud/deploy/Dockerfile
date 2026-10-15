# Images for the API (also serves the web app) and the worker.
#   docker build -f deploy/Dockerfile --target api    -t verifycloud-api .
#   docker build -f deploy/Dockerfile --target worker -t verifycloud-worker .
ARG NODE_IMAGE=node:22-bookworm-slim
ARG WORKER_BASE=ubuntu:24.04

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/worker/package.json packages/worker/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
# Optional: behind a TLS-intercepting proxy, pass its CA as the build secret
# "extra_ca" (see deploy/build-behind-proxy.yml). Without it nothing changes.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY packages packages
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/shared/package.json packages/shared/
COPY --from=build /src/packages/shared/dist packages/shared/dist

FROM runtime-base AS api
COPY --from=build /src/packages/server/package.json packages/server/
COPY --from=build /src/packages/server/dist packages/server/dist
COPY --from=build /src/packages/web/dist packages/web/dist
COPY examples/axi4lite-demo examples/axi4lite-demo
ENV PORT=8080 STATIC_DIR=/app/packages/web/dist DEMO_EXAMPLE_DIR=/app/examples/axi4lite-demo
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]

# Worker: Ubuntu 24.04 base, because the Docker CLI must be recent enough for
# current engines (Debian bookworm's docker.io is 20.10 / API 1.41, which
# newer engines refuse — audit 2026-10-08). Node is copied from the build stage.
FROM ${WORKER_BASE} AS worker
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/sbin/dockerd /usr/bin/dockerd /usr/bin/containerd* /usr/sbin/runc /usr/bin/runc
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/shared/package.json packages/shared/
COPY --from=build /src/packages/shared/dist packages/shared/dist
COPY --from=build /src/packages/worker/package.json packages/worker/
COPY --from=build /src/packages/worker/dist packages/worker/dist
COPY packages/worker/harness packages/worker/harness
ENV WORK_DIR=/var/lib/verifycloud-worker
CMD ["node", "packages/worker/dist/main.js"]
