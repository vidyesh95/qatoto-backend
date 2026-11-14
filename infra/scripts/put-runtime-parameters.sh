#!/usr/bin/env bash
# Uploads a production dotenv file into SSM Parameter Store as SecureStrings under
# /qatoto/prod/<VARIABLE>, which deploy/remote-deploy.sh renders back into .env on the
# instance at every deploy. Run from a laptop with an AWS session (`aws login`):
#
#   infra/scripts/put-runtime-parameters.sh path/to/production.env \
#     [path/to/aiven-ca.pem [path/to/cf-origin.pem path/to/cf-origin-key.pem]]
#
# Pass `-` as the dotenv file to upload only the PEM files.
#
# The PEM files are stored as DATABASE_CA_CERT, CLOUDFLARE_ORIGIN_CERT and
# CLOUDFLARE_ORIGIN_KEY. remote-deploy.sh writes them to files on the instance and never
# into .env, so the origin private key never reaches the app's environment.
#
# - Overwrites existing parameters of the same name; never deletes any. To retire a
#   variable: aws ssm delete-parameter --name /qatoto/prod/<VARIABLE>
# - Values are passed through --cli-input-json, so a value that starts with `http://`,
#   `-` or `file://` is stored literally rather than interpreted by the CLI.
# - Prints variable NAMES only, never values.
# - DATABASE_POOL_MAX / WORKER_DATABASE_POOL_MAX / NODE_ENV / PORT / TZ /
#   DATABASE_CA_CERT_PATH are skipped: deploy/docker-compose.prod.yml sets them and
#   compose `environment` would override the parameter anyway.
set -euo pipefail

readonly usage="usage: put-runtime-parameters.sh <production.env|-> [aiven-ca.pem [cf-origin.pem cf-origin-key.pem]]"
readonly dotenv_file="${1:?$usage}"
readonly ca_certificate_file="${2:-}"
readonly origin_certificate_file="${3:-}"
readonly origin_private_key_file="${4:-}"
readonly parameter_path=/qatoto/prod
readonly compose_owned_variables=" DATABASE_POOL_MAX WORKER_DATABASE_POOL_MAX NODE_ENV PORT TZ DATABASE_CA_CERT_PATH "
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

if [[ -n "$origin_certificate_file" && -z "$origin_private_key_file" ]]; then
  echo "$usage" >&2
  echo "the Cloudflare origin certificate and its private key go together" >&2
  exit 1
fi
# Checked here so a mismatched pair never reaches Parameter Store (remote-deploy.sh checks
# again before it replaces the running pair).
if [[ -n "$origin_certificate_file" ]] &&
  [[ "$(openssl x509 -in "$origin_certificate_file" -noout -pubkey)" != \
  "$(openssl pkey -in "$origin_private_key_file" -pubout)" ]]; then
  echo "$origin_private_key_file is not the private key of $origin_certificate_file" >&2
  exit 1
fi

# The request JSON goes through a private temp file: AWS CLI v2 on macOS cannot read
# --cli-input-json from file:///dev/stdin ("Invalid JSON received"), and argv would expose
# the value in `ps`.
umask 077
request_directory="$(mktemp -d)"
trap 'rm -rf "$request_directory"' EXIT

put_secure_parameter() {
  local variable_name="$1"
  local variable_value="$2"
  local request_file="$request_directory/request.json"
  jq -n \
    --arg name "$parameter_path/$variable_name" \
    --arg value "$variable_value" \
    '{Name: $name, Value: $value, Type: "SecureString", Overwrite: true, Tier: "Standard"}' \
    > "$request_file"
  aws ssm put-parameter --cli-input-json "file://$request_file" --output text --query Version > /dev/null
  rm -f "$request_file"
  echo "stored $parameter_path/$variable_name"
}

if [[ "$dotenv_file" != "-" ]]; then
  while IFS= read -r dotenv_line || [[ -n "$dotenv_line" ]]; do
    [[ "$dotenv_line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! "$dotenv_line" =~ ^(export[[:space:]]+)?([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "skipped a line that is not KEY=value" >&2
      continue
    fi
    variable_name="${BASH_REMATCH[2]}"
    variable_value="${BASH_REMATCH[3]}"

    if [[ "$compose_owned_variables" == *" $variable_name "* ]]; then
      echo "skipped $variable_name (set by deploy/docker-compose.prod.yml)"
      continue
    fi

    # Strip one pair of surrounding quotes, as dotenv does.
    if [[ "$variable_value" =~ ^\"(.*)\"$ || "$variable_value" =~ ^\'(.*)\'$ ]]; then
      variable_value="${BASH_REMATCH[1]}"
    fi
    if [[ -z "$variable_value" ]]; then
      echo "skipped $variable_name (empty)"
      continue
    fi

    put_secure_parameter "$variable_name" "$variable_value"
  done < "$dotenv_file"
fi

if [[ -n "$ca_certificate_file" ]]; then
  put_secure_parameter DATABASE_CA_CERT "$(cat "$ca_certificate_file")"
fi
if [[ -n "$origin_certificate_file" ]]; then
  put_secure_parameter CLOUDFLARE_ORIGIN_CERT "$(cat "$origin_certificate_file")"
  put_secure_parameter CLOUDFLARE_ORIGIN_KEY "$(cat "$origin_private_key_file")"
fi
