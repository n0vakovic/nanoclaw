#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(git branch --show-current)" != main ]]; then
  echo "Deployment requires checkout of main." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Deployment requires a clean, committed main checkout." >&2
  exit 1
fi
npm run typecheck
npm test
npm run build
systemctl --user restart nanoclaw.service
systemctl --user is-active --quiet nanoclaw.service
echo "Deployed $(git rev-parse --short HEAD) from main"
