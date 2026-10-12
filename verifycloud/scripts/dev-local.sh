#!/usr/bin/env bash
# Local development without docker-compose: API + worker as host processes,
# using an existing PostgreSQL and S3-compatible endpoint. Simulations still
# run in the Docker sandbox (image verifycloud-sim:verilator).
#   DATABASE_URL=postgres://postgres@127.0.0.1:5432/verifycloud_dev \
#   S3_ENDPOINT=http://127.0.0.1:9000 scripts/dev-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://postgres@127.0.0.1:5432/verifycloud_dev}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}" S3_BUCKET="${S3_BUCKET:-verifycloud-dev}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-minioadmin}" S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-minioadmin}"
export PORT="${PORT:-8080}" PUBLIC_URL="${PUBLIC_URL:-http://localhost:8080}" STATIC_DIR="${STATIC_DIR:-packages/web/dist}"
export DEMO_SEED=true DEMO_ADMIN_EMAIL="${DEMO_ADMIN_EMAIL:-admin@demo.local}" DEMO_ADMIN_PASSWORD="${DEMO_ADMIN_PASSWORD:-change-me-locally}"
export DEMO_PATCH_FILE="${DEMO_PATCH_FILE:-examples/axi4lite-demo/fix-rdata-stable.patch}"
db="${DATABASE_URL##*/}"; admin="${DATABASE_URL%/*}/postgres"
psql "$admin" -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql "$admin" -c "CREATE DATABASE $db"
npm run build >/dev/null
node packages/server/dist/main.js &
api=$!
trap 'kill $api $wrk 2>/dev/null' EXIT
until curl -fs "http://127.0.0.1:$PORT/health" >/dev/null; do sleep 0.5; done
API_URL="http://127.0.0.1:$PORT" node packages/worker/dist/main.js &
wrk=$!
echo "VerifyCloud: http://localhost:$PORT  (login $DEMO_ADMIN_EMAIL / $DEMO_ADMIN_PASSWORD)"
wait
