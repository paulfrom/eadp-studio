#!/usr/bin/env bash
# One-click local startup of the collaboration backend (PostgreSQL + API) via Docker Compose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT/apps/collaboration-api/compose.yml"
ENV_FILE="$ROOT/apps/collaboration-api/.env"

command -v docker >/dev/null 2>&1 || { echo "error: docker is required but not found in PATH." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "error: the Docker Compose plugin is required (docker compose)." >&2; exit 1; }

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

API_PORT="${EADP_API_PORT:-6972}"

: "${GITLAB_URL:?GITLAB_URL is required. Copy apps/collaboration-api/.env.example to apps/collaboration-api/.env and fill it in.}"
export GITLAB_URL

echo "Starting collaboration backend on port ${API_PORT} ..."
docker compose -f "$COMPOSE_FILE" up -d --build

HEALTH_URL="http://127.0.0.1:${API_PORT}/health"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  healthy=0
  if command -v curl >/dev/null 2>&1 && curl -fsS --noproxy '*' "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
  else
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' eadp-collaboration-api-1 2>/dev/null || true)
    [[ "$status" == "healthy" ]] && healthy=1
  fi
  if [[ "$healthy" == "1" ]]; then
    echo "Collaboration API is up:"
    echo "  health:  $HEALTH_URL"
    echo "  update:  http://127.0.0.1:${API_PORT}/api/v0/check_client_update"
    echo "  logs:    docker compose -f $COMPOSE_FILE logs -f api"
    echo "  stop:    docker compose -f $COMPOSE_FILE down"
    exit 0
  fi
  sleep 2
done

echo "error: the API did not become healthy in time. Recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=50 api >&2 || true
exit 1
