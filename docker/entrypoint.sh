#!/bin/sh
set -eu

# Aiven (and similar managed Postgres) needs the provider CA on disk.
# Dokploy's Environment tab is the usual place to paste that PEM; this
# writes it to the path `src/db/index.ts` already reads. A bind-mounted
# file at DATABASE_CA_CERT_PATH is left alone when DATABASE_CA_CERT is unset.
if [ -n "${DATABASE_CA_CERT:-}" ]; then
  cert_path="${DATABASE_CA_CERT_PATH:-/certs/ca.pem}"
  mkdir -p "$(dirname "$cert_path")"
  printf '%s\n' "$DATABASE_CA_CERT" | sed 's/\\n/\n/g' > "$cert_path"
  export DATABASE_CA_CERT_PATH="$cert_path"
fi

exec "$@"
