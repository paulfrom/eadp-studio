#!/usr/bin/env bash
# One-click local startup of the collaboration backend API via Docker Compose.
# PostgreSQL and Redis are the instances this machine already shares; no database or
# cache container is started and no postgres or redis image is pulled here.
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

: "${DATABASE_URL:?DATABASE_URL is required. Point it at the shared PostgreSQL instance in apps/collaboration-api/.env.}"
: "${GITLAB_URL:?GITLAB_URL is required. Copy apps/collaboration-api/.env.example to apps/collaboration-api/.env and fill it in.}"

# The API port is published by Docker on the host, so the container listens on 3001
# and the host serves EADP_API_PORT.
API_PORT="${EADP_API_PORT:-${PORT:-6972}}"
export EADP_API_PORT="$API_PORT"

# Free the API port if a host process (e.g. a leftover host dev server) holds it.
# Container processes are left to compose, which recreates this project's containers.
occupants=$(ss -tlnHp "sport = :${API_PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
for pid in $occupants; do
  comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
  if [[ "$comm" == "docker-proxy" || -z "$comm" ]]; then
    continue
  fi
  if grep -qsE 'docker|containerd' "/proc/$pid/cgroup" 2>/dev/null; then
    continue
  fi
  echo "Port ${API_PORT} is held by PID ${pid} (${comm}); killing it."
  kill "$pid" 2>/dev/null || true
done
if [[ -n "$occupants" ]]; then
  for _ in 1 2 3 4 5; do
    ss -tlnH "sport = :${API_PORT}" 2>/dev/null | grep -q . || break
    sleep 1
  done
fi

echo "Starting collaboration backend on port ${API_PORT} ..."
# --remove-orphans drops the retired database and cache containers of this project.
docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api)"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  state=$(docker inspect -f '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || echo missing)
  if [[ "$state" != "running" ]]; then
    echo "error: the API container is not running (state: ${state}). Recent logs:" >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=50 api >&2 || true
    exit 1
  fi
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)
  if [[ "$status" == "healthy" ]]; then
    echo "Collaboration API is up:"
    echo "  health:  http://127.0.0.1:${API_PORT}/health"
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
