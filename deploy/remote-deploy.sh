#!/usr/bin/env bash
# Runs ON the EC2 instance, as root, through SSM Run Command from
# .github/workflows/deploy.yml. Not meant to be run from a laptop.
#
#   remote-deploy.sh <40-char commit sha> <api hostname>
#
# 1. Renders /opt/qatoto/.env (mode 600) from every SecureString under /qatoto/prod.
#    The PEM parameters are written to files instead — a multi-line PEM cannot ride in a
#    compose env_file, and the origin key must never reach the app's environment:
#      DATABASE_CA_CERT       → certs/ca.pem         (Aiven CA, read by api/worker/migrate)
#      CLOUDFLARE_ORIGIN_CERT → tls/origin.pem       (Cloudflare Origin CA cert, Caddy)
#      CLOUDFLARE_ORIGIN_KEY  → tls/origin-key.pem   (its private key, Caddy, mode 600)
#    Also fetches Cloudflare's published IP ranges for Caddy's trusted_proxies.
# 2. Pulls ghcr.io/vidyesh95/qatoto-backend:sha-<sha> and brings the stack up
#    (migrate → api + worker → caddy).
# 3. Waits for the api healthcheck, reloads Caddy (bind-mounted Caddyfile and certificate
#    changes are invisible to `compose up`), then prunes images older than a week (the
#    window in which a rollback by SHA is a pull-free restart).
set -euo pipefail

readonly deploy_sha="${1:?usage: remote-deploy.sh <commit-sha> <api-hostname>}"
readonly api_hostname="${2:?usage: remote-deploy.sh <commit-sha> <api-hostname>}"
readonly app_directory=/opt/qatoto
readonly parameter_path=/qatoto/prod
readonly api_health_timeout_seconds=180
# Parameters written to files below, never into .env. Keep in sync with the jq filter.
readonly file_parameter_names='["DATABASE_CA_CERT","CLOUDFLARE_ORIGIN_CERT","CLOUDFLARE_ORIGIN_KEY"]'
readonly origin_certificate_minimum_validity_seconds=$((30 * 24 * 3600))

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
jq -r --arg prefix "$parameter_path/" --arg quote "'" --argjson file_parameter_names "$file_parameter_names" '
  .Parameters[]
  | (.Name | ltrimstr($prefix)) as $variable_name
  | select(any($file_parameter_names[]; . == $variable_name) | not)
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

# Prints one PEM parameter's value, or fails the deploy naming what is missing. Without
# the file, a compose bind mount would create a DIRECTORY in its place.
read_pem_parameter() {
  local variable_name="$1"
  local what_it_is="$2"
  local parameter_value
  parameter_value="$(jq -r --arg name "$parameter_path/$variable_name" \
    '.Parameters[] | select(.Name == $name) | .Value' "$parameters_json_file")"
  if [[ -z "$parameter_value" ]]; then
    echo "deploy: $parameter_path/$variable_name ($what_it_is) is missing from Parameter Store" >&2
    return 1
  fi
  # Accept the PEM pasted either with real newlines or with literal `\n` escapes (the form
  # the Dokploy-era DATABASE_CA_CERT used; docker/entrypoint.sh accepts it the same way).
  printf '%s\n' "${parameter_value//\\n/$'\n'}"
}

# Aiven requires verified TLS.
database_ca_certificate="$(read_pem_parameter DATABASE_CA_CERT "the Aiven CA PEM")"
install -d -m 755 "$app_directory/certs"
# The container runs as `node`, so the (public) CA certificate must be world-readable.
printf '%s\n' "$database_ca_certificate" | install -m 644 /dev/stdin "$app_directory/certs/ca.pem"

# Cloudflare Origin CA certificate and key for Caddy. Checked before they replace the
# running pair: wrong hostname, mismatched key or near expiry fails the deploy here, while
# the old Caddy keeps serving.
origin_certificate="$(read_pem_parameter CLOUDFLARE_ORIGIN_CERT "the Cloudflare Origin CA certificate")"
origin_private_key="$(read_pem_parameter CLOUDFLARE_ORIGIN_KEY "the Cloudflare Origin CA private key")"
staged_tls_directory="$(mktemp -d "$app_directory/.tls.XXXXXX")"
trap 'rm -rf "$parameters_json_file" "$rendered_env_file" "$staged_tls_directory"' EXIT
printf '%s\n' "$origin_certificate" | install -m 644 /dev/stdin "$staged_tls_directory/origin.pem"
printf '%s\n' "$origin_private_key" | install -m 600 /dev/stdin "$staged_tls_directory/origin-key.pem"
if ! openssl x509 -in "$staged_tls_directory/origin.pem" -noout -checkhost "$api_hostname" | grep -q ' does match '; then
  echo "deploy: CLOUDFLARE_ORIGIN_CERT does not cover $api_hostname" >&2
  exit 1
fi
if ! openssl x509 -in "$staged_tls_directory/origin.pem" -noout \
  -checkend "$origin_certificate_minimum_validity_seconds" > /dev/null; then
  echo "deploy: CLOUDFLARE_ORIGIN_CERT expires within 30 days — issue a new one (infra/README.md)" >&2
  exit 1
fi
if [[ "$(openssl x509 -in "$staged_tls_directory/origin.pem" -noout -pubkey)" != \
  "$(openssl pkey -in "$staged_tls_directory/origin-key.pem" -pubout)" ]]; then
  echo "deploy: CLOUDFLARE_ORIGIN_KEY does not belong to CLOUDFLARE_ORIGIN_CERT" >&2
  exit 1
fi
rm -rf "$app_directory/tls"
mv "$staged_tls_directory" "$app_directory/tls"
# mktemp -d creates mode 700; Caddy runs as root in its container, so that is enough.

# Caddy believes CF-Connecting-IP only from these peers (see the Caddyfile). Fetched each
# deploy so a range Cloudflare adds is trusted after the next deploy; a failed or
# malformed fetch fails the deploy rather than starting Caddy with no trusted proxies.
cloudflare_ip_ranges_json="$(curl -fsS --retry 3 https://api.cloudflare.com/client/v4/ips)"
CLOUDFLARE_TRUSTED_PROXIES="$(jq -r '
  if .success != true then error("Cloudflare /ips returned success=false") else . end
  | (.result.ipv4_cidrs + .result.ipv6_cidrs) as $ranges
  | if ($ranges | length) < 10 then error("Cloudflare /ips returned too few ranges")
    elif ($ranges | all(test("^[0-9a-f.:]+/[0-9]{1,3}$")) | not) then error("Cloudflare /ips returned a malformed range")
    else $ranges | join(" ") end
' <<< "$cloudflare_ip_ranges_json")"
export CLOUDFLARE_TRUSTED_PROXIES

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

# compose recreates a container only when its own definition changes. A new Caddyfile or
# certificate behind an unchanged bind mount would otherwise be ignored until a reboot.
# Graceful: on a config error Caddy keeps the running config and this fails the deploy.
"${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force

echo "$deploy_sha" > "$app_directory/DEPLOYED_SHA"
docker image prune --all --force --filter "until=168h" > /dev/null
echo "deploy: sha-$deploy_sha is live"
