# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --network-concurrency 1

FROM deps AS build

COPY tsconfig.json tsconfig.node.json ./
COPY src ./src
# Skip source maps and incremental state — both inflate RSS on a small VPS.
# node_modules stay in this stage so the runner cannot COPY them in parallel with tsc.
RUN pnpm exec tsc --pretty false --incremental false --sourceMap false

FROM base AS runner

ENV NODE_ENV=production
ENV TZ=UTC
ENV PORT=8000

RUN mkdir -p /certs \
  && chown node:node /certs

# Copy from `build` (not `deps`) so BuildKit cannot copy node_modules while tsc is running.
# Do not --chown these trees: Docker copies then chowns in memory and OOM-kills the build.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

USER node
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
