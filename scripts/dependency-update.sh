#!/usr/bin/env bash
# Materialize the fixed DSH source recorded in release.lock.json; see scripts/dependency-update.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in node git tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' is required to update the fixed DSH source." >&2
    exit 1
  fi
done
exec node scripts/dependency-update.mjs
