# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json tsconfig.node.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm build

FROM base AS runner

ENV NODE_ENV=production
ENV TZ=UTC
ENV PORT=8000

RUN mkdir -p /certs \
  && chown node:node /certs

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node drizzle.config.ts ./
COPY --chown=node:node docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

USER node
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
