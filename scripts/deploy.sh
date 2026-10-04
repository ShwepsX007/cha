#!/usr/bin/env bash
#
# One-command production deploy: dependencies -> schema -> build -> reload.
#
# The order matters. Restarting pm2 without `npm run build` keeps serving the
# previous .next output, which is how a server ends up "running but broken"
# after a git pull. And skipping `db:setup` makes every API request fail while
# `next start` still logs "Ready".
#
# Usage:  bash scripts/deploy.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env is missing. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci

echo "==> Applying database migrations"
npm run db:setup

echo "==> Building the production bundle"
npm run build

if command -v pm2 >/dev/null 2>&1; then
  echo "==> Reloading pm2 process"
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save
  HOSTPORT="${PORT:-8010}"
  echo "==> Health check"
  sleep 2
  curl -fsS "http://127.0.0.1:${HOSTPORT}/api/health" || {
    echo "WARNING: /api/health did not answer. Check: pm2 logs chata --lines 100" >&2
    exit 1
  }
  echo
else
  echo "pm2 is not installed. Start the app with: npm run start"
fi
