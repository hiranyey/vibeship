# syntax=docker/dockerfile:1

# The static Docker CLI and compose plugin, copied in so Vibeship can drive
# the host's Docker daemon through the mounted socket.
FROM docker:29.9.2-cli AS docker-cli

FROM node:26.13.0-slim AS base
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY package.json package-lock.json ./

# Local development: dependencies only; compose.dev.yaml mounts src/ and
# node --watch restarts on changes.
FROM base AS dev
ENV NODE_ENV=development
RUN npm ci
CMD ["node", "--watch", "src/server.ts"]

# Runs as root on purpose: it needs the Docker socket, which is root-equivalent anyway.
FROM base AS prod
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.ts"]
