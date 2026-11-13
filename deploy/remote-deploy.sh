#!/usr/bin/env bash
# Runs ON the EC2 instance, as root, through SSM Run Command from
# .github/workflows/deploy.yml. Not meant to be run from a laptop.
#
#   remote-deploy.sh <40-char commit sha> <api hostname>
#
# 1. Renders /opt/qatoto/.env (mode 600) from every SecureString under /qatoto/prod.
#    DATABASE_CA_CERT is written to /opt/qatoto/certs/ca.pem instead — a multi-line PEM
#    cannot ride in a compose env_file.
# 2. Pulls ghcr.io/vidyesh95/qatoto-backend:sha-<sha> and brings the stack up
#    (migrate → api + worker → caddy).
# 3. Waits for the api healthcheck, then prunes images older than a week (the window in
#    which a rollback by SHA is a pull-free restart).
set -euo pipefail

readonly deploy_sha="${1:?usage: remote-deploy.sh <commit-sha> <api-hostname>}"
readonly api_hostname="${2:?usage: remote-deploy.sh <commit-sha> <api-hostname>}"
readonly app_directory=/opt/qatoto
readonly parameter_path=/qatoto/prod
readonly api_health_timeout_seconds=180

if [[ ! "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deploy: '$deploy_sha' is not a 40-character commit SHA" >&2
  exit 1
fi
if [[ ! "$api_hostname" =~ ^[a-z0-9.-]+$ ]]; then
  echo "deploy: '$api_hostname' is not a hostname" >&2
  exit 1
fi

# A deploy that lands while first-boot provisioning is still running would find no docker.
cloud-init status --wait > /dev/null

cd "$app_directory"

imds_token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
AWS_DEFAULT_REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" \
  http://169.254.169.254/latest/meta-data/placement/region)"
export AWS_DEFAULT_REGION

# ── 1. Runtime configuration from Parameter Store ───────────────────────────────
umask 077
parameters_json_file="$(mktemp)"
rendered_env_file="$(mktemp "$app_directory/.env.XXXXXX")"
trap 'rm -f "$parameters_json_file" "$rendered_env_file"' EXIT

aws ssm get-parameters-by-path \
  --path "$parameter_path" \
  --recursive \
  --with-decryption \
  --output json > "$parameters_json_file"

# Values are single-quoted so compose neither interpolates `$` nor strips ` #` — base64
# secrets and URLs pass through byte for byte. A single quote or newline cannot be
# represented that way, so such a value fails the deploy by NAME (never by value).
jq -r --arg prefix "$parameter_path/" --arg quote "'" '
  .Parameters[]
  | (.Name | ltrimstr($prefix)) as $variable_name
  | select($variable_name != "DATABASE_CA_CERT")
  | if ($variable_name | test("^[A-Z][A-Z0-9_]*$") | not) then
      error("parameter \(.Name) is not a valid environment variable name")
    elif (.Value | contains("\n") or contains($quote)) then
      error("parameter \(.Name) contains a newline or single quote")
    else
      "\($variable_name)=\($quote)\(.Value)\($quote)"
    end
' "$parameters_json_file" > "$rendered_env_file"

if ! grep -q '^DATABASE_URL=' "$rendered_env_file"; then
  echo "deploy: $parameter_path/DATABASE_URL is missing from Parameter Store" >&2
  exit 1
fi

# Aiven requires verified TLS. Without the CA the bind mount in the compose file would
# create a DIRECTORY at certs/ca.pem, so a missing parameter fails here instead.
database_ca_certificate="$(jq -r --arg name "$parameter_path/DATABASE_CA_CERT" \
  '.Parameters[] | select(.Name == $name) | .Value' "$parameters_json_file")"
if [[ -z "$database_ca_certificate" ]]; then
  echo "deploy: $parameter_path/DATABASE_CA_CERT (the Aiven CA PEM) is missing from Parameter Store" >&2
  exit 1
fi
# Accept the PEM pasted either with real newlines or with literal `\n` escapes (the form
# the Dokploy-era DATABASE_CA_CERT used; docker/entrypoint.sh accepts it the same way).
database_ca_certificate="${database_ca_certificate//\\n/$'\n'}"
install -d -m 755 "$app_directory/certs"
# The container runs as `node`, so the (public) CA certificate must be world-readable.
printf '%s\n' "$database_ca_certificate" | install -m 644 /dev/stdin "$app_directory/certs/ca.pem"

chmod 600 "$rendered_env_file"
mv "$rendered_env_file" "$app_directory/.env"
echo "deploy: rendered $(grep -c '=' "$app_directory/.env") variables from $parameter_path"

# ── 2. Pull and start ───────────────────────────────────────────────────────────
export IMAGE_TAG="sha-$deploy_sha"
export API_HOSTNAME="$api_hostname"
compose=(docker compose --project-directory "$app_directory" --file "$app_directory/docker-compose.yml")

"${compose[@]}" pull --quiet

# Blocks until migrate exits; a non-zero migrate aborts here, before api is recreated.
if ! "${compose[@]}" up --detach --remove-orphans; then
  echo "deploy: compose up failed — migrate output follows" >&2
  "${compose[@]}" logs --no-color --tail 200 migrate >&2 || true
  exit 1
fi

# ── 3. Wait for the api healthcheck ─────────────────────────────────────────────
api_container_id="$("${compose[@]}" ps --quiet api)"
deadline=$((SECONDS + api_health_timeout_seconds))
api_health_status="starting"
while ((SECONDS < deadline)); do
  api_health_status="$(docker inspect --format '{{.State.Health.Status}}' "$api_container_id")"
  if [[ "$api_health_status" == "healthy" || "$api_health_status" == "unhealthy" ]]; then
    break
  fi
  sleep 3
done

"${compose[@]}" ps --all

if [[ "$api_health_status" != "healthy" ]]; then
  echo "deploy: api is '$api_health_status' after ${api_health_timeout_seconds}s — logs follow" >&2
  "${compose[@]}" logs --no-color --tail 200 api >&2 || true
  exit 1
fi

echo "$deploy_sha" > "$app_directory/DEPLOYED_SHA"
docker image prune --all --force --filter "until=168h" > /dev/null
echo "deploy: sha-$deploy_sha is live"
