#!/usr/bin/env bash
# Uploads a production dotenv file into SSM Parameter Store as SecureStrings under
# /qatoto/prod/<VARIABLE>, which deploy/remote-deploy.sh renders back into .env on the
# instance at every deploy. Run from a laptop with an AWS session (`aws login`):
#
#   infra/scripts/put-runtime-parameters.sh path/to/production.env [path/to/aiven-ca.pem]
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

readonly dotenv_file="${1:?usage: put-runtime-parameters.sh <production.env> [aiven-ca.pem]}"
readonly ca_certificate_file="${2:-}"
readonly parameter_path=/qatoto/prod
readonly compose_owned_variables=" DATABASE_POOL_MAX WORKER_DATABASE_POOL_MAX NODE_ENV PORT TZ DATABASE_CA_CERT_PATH "
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

put_secure_parameter() {
  local variable_name="$1"
  local variable_value="$2"
  jq -n \
    --arg name "$parameter_path/$variable_name" \
    --arg value "$variable_value" \
    '{Name: $name, Value: $value, Type: "SecureString", Overwrite: true, Tier: "Standard"}' |
    aws ssm put-parameter --cli-input-json file:///dev/stdin --output text --query Version > /dev/null
  echo "stored $parameter_path/$variable_name"
}

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

if [[ -n "$ca_certificate_file" ]]; then
  put_secure_parameter DATABASE_CA_CERT "$(cat "$ca_certificate_file")"
fi
