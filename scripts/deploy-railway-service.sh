#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"

service_id="${1:?service ID is required}"
role="${2:?service role is required}"
case "$role" in api|worker) ;; *) echo "Service role must be api or worker." >&2; exit 1 ;; esac
artifact_dir="${DEPLOYMENT_ARTIFACT_DIR:-artifacts}"
stamp="backend/.railway-deployment-source"
mkdir -p "$artifact_dir"
trap 'rm -f "$stamp"' EXIT

write_failure() {
  local result="$1"
  local deployment_id="${2:-unavailable}"
  printf 'role=%s\ncommit=%s\ndeployment_id=%s\nresult=%s\n' \
    "$role" "$EXPECTED_COMMIT_SHA" "$deployment_id" "$result" \
    > "$artifact_dir/railway-${role}-failure.txt"
}

actual_commit="$(git rev-parse HEAD)"
if [[ "$actual_commit" != "$EXPECTED_COMMIT_SHA" ]]; then
  echo "Checked-out commit no longer matches the intended deployment." >&2
  exit 1
fi

# This watched file forces Railway to upload the checked-out workspace even for
# workflow-only commits. The status poll below supplies the terminal-state gate.
previous_json="$(railway deployment list --json --limit 1 \
  --service "$service_id" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --project "$RAILWAY_PROJECT_ID")"
previous_id="$(jq -r 'if type == "array" then (.[0].id // "") else (.deployments[0].id // "") end' <<<"$previous_json")"

printf '%s:%s\n' "$EXPECTED_COMMIT_SHA" "$role" > "$stamp"
if ! railway up --ci --yes \
  --service "$service_id" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --project "$RAILWAY_PROJECT_ID"; then
  write_failure "upload-or-build-failed"
  exit 1
fi

deployment_id=""
deployment_status=""
for _ in $(seq 1 60); do
  deployment_json="$(railway deployment list --json --limit 1 \
    --service "$service_id" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --project "$RAILWAY_PROJECT_ID")"
  deployment_id="$(jq -r 'if type == "array" then (.[0].id // "") else (.deployments[0].id // "") end' <<<"$deployment_json")"
  deployment_status="$(jq -r 'if type == "array" then (.[0].status // "") else (.deployments[0].status // "") end | ascii_upcase' <<<"$deployment_json")"
  if [[ -n "$deployment_id" && "$deployment_id" != "$previous_id" ]]; then
    case "$deployment_status" in
      SUCCESS)
        jq -n \
          --arg role "$role" \
          --arg commit "$EXPECTED_COMMIT_SHA" \
          --arg deployment_id "$deployment_id" \
          --arg result "$deployment_status" \
          '{role:$role,commit:$commit,deployment_id:$deployment_id,result:$result}' \
          > "$artifact_dir/railway-${role}-deployment.json"
        exit 0
        ;;
      FAILED|CRASHED|REMOVED|SKIPPED)
        write_failure "$deployment_status" "$deployment_id"
        echo "Railway $role deployment ended with $deployment_status." >&2
        exit 1
        ;;
    esac
  fi
  sleep 5
done

write_failure "terminal-status-timeout" "$deployment_id"
echo "Railway $role deployment did not reach a successful terminal state; last status was ${deployment_status:-unavailable}." >&2
exit 1
