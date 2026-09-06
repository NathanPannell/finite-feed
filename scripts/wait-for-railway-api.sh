#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"

domain=""
for attempt in $(seq 1 30); do
  domains_json="$(railway domain list \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$RAILWAY_API_SERVICE_ID" \
    --json 2>/dev/null || true)"
  domain="$(jq -r '.. | strings | select(test("\\.up\\.railway\\.app$"))' <<<"$domains_json" | head -n 1)"
  if [[ -n "$domain" ]]; then
    break
  fi
  if [[ "$attempt" == "3" ]]; then
    railway domain --port 8080 \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT" \
      --service "$RAILWAY_API_SERVICE_ID" \
      --json >/dev/null 2>&1 || true
  fi
  sleep 10
done

if [[ -z "$domain" ]]; then
  echo "No Railway-provided API domain appeared." >&2
  exit 1
fi

api_url="https://${domain}"
expected_origin="${EXPECTED_FRONTEND_ORIGIN:-}"
require_worker="${REQUIRE_WORKER_READY:-false}"
max_worker_age="${MAX_WORKER_HEARTBEAT_AGE_SECONDS:-180}"
last_status=""
last_commit=""
last_origin_ready="not-required"
for _ in $(seq 1 60); do
  response="$(curl --fail --silent --show-error --max-time 10 "${api_url}/ready" 2>/dev/null || true)"
  last_status="$(jq -r '.status // empty' <<<"$response" 2>/dev/null)"
  last_commit="$(jq -r '.commit // empty' <<<"$response" 2>/dev/null)"
  if [[ -n "$expected_origin" ]]; then
    if jq -e --arg origin "$expected_origin" '(.allowed_origins // []) | index($origin) != null' <<<"$response" >/dev/null 2>&1; then
      last_origin_ready="yes"
    else
      last_origin_ready="no"
    fi
  fi
  readiness_args=(--expected-commit "$EXPECTED_COMMIT_SHA" --max-worker-age-seconds "$max_worker_age")
  [[ -n "$expected_origin" ]] && readiness_args+=(--expected-origin "$expected_origin")
  [[ "$require_worker" == "true" ]] && readiness_args+=(--require-worker)
  if node scripts/validate-deployment-readiness.mjs "${readiness_args[@]}" <<<"$response" 2>/dev/null; then
    echo "api_url=${api_url}" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  sleep 10
done

worker_status="$(jq -r '.worker.status // "unavailable"' <<<"${response:-{}}" 2>/dev/null || true)"
worker_commit="$(jq -r '.worker.commit // "unavailable"' <<<"${response:-{}}" 2>/dev/null || true)"
artifact_dir="${DEPLOYMENT_ARTIFACT_DIR:-artifacts}"
artifact_name="${READINESS_ARTIFACT_NAME:-railway-readiness}"
mkdir -p "$artifact_dir"
jq -n \
  --arg expected_commit "$EXPECTED_COMMIT_SHA" \
  --arg api_status "${last_status:-unavailable}" \
  --arg api_commit "${last_commit:-unavailable}" \
  --arg worker_status "${worker_status:-unavailable}" \
  --arg worker_commit "${worker_commit:-unavailable}" \
  '{expected_commit:$expected_commit,api_status:$api_status,api_commit:$api_commit,worker_status:$worker_status,worker_commit:$worker_commit}' \
  > "$artifact_dir/${artifact_name}.json"
echo "Railway API never reported the expected ready state at ${api_url}; status=${last_status:-unavailable}, commit=${last_commit:-unavailable}, frontend-origin-ready=${last_origin_ready}, worker-status=${worker_status:-unavailable}, worker-commit=${worker_commit:-unavailable}" >&2
exit 1
