# Setun application image: the @sveltejs/adapter-bun build, started by `bun ./server.js` (PRD §5).
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun --bun run build
RUN bun build ./scripts/recover-educator.ts --target=bun --outfile=/app/recover-educator.js

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `docker stop` (and `docker compose stop`) sends SIGTERM and kills the process
# 10 s later. The adapter's own 30 s drain would be cut off there, so an open
# chat stream died with the process instead of ending cleanly. 7 s fits the
# drain, closing and exiting inside that budget; set SHUTDOWN_TIMEOUT (and a
# longer `docker stop -t` or `stop_grace_period`) to change it.
ENV SHUTDOWN_TIMEOUT=7

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/build ./build
# Boot migrations and the operator recovery entry point must exist without source files.
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/recover-educator.js ./recover-educator.js
# The production entry: the process guard, and the ORIGIN front for the adapter-bun build.
COPY server.js server-guard.js ./

EXPOSE 3000
CMD ["bun", "./server.js"]
