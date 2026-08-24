#!/bin/sh
set -eu

# Applied as the compose `migrate` service. Do not go through `pnpm`:
# NODE_ENV=production plus a copied pnpm store makes `pnpm db:migrate` fail
# even when drizzle-kit is already in node_modules.

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate: DATABASE_URL is not set" >&2
  exit 1
fi

if [ -n "${DATABASE_CA_CERT_PATH:-}" ] && [ ! -f "${DATABASE_CA_CERT_PATH}" ]; then
  echo "migrate: DATABASE_CA_CERT_PATH=${DATABASE_CA_CERT_PATH} is not a file in this container." >&2
  echo "migrate: paste the Aiven CA PEM into DATABASE_CA_CERT, or mount the cert at that path." >&2
  exit 1
fi

echo "migrate: applying drizzle SQL"
./node_modules/.bin/drizzle-kit migrate

echo "migrate: installing pg-boss queues"
node dist/jobs-install.js

echo "migrate: done"
