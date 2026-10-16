#!/bin/sh
set -eu
cd /app/apps/collaboration-api
node --import=tsx src/persistence/ensure-schema.ts
exec node --use-env-proxy --import=tsx src/bootstrap.ts
