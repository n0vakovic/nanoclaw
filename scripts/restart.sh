#!/bin/bash
cd "$(dirname "$0")/.."
npm run build && systemctl --user restart nanoclaw
echo "NanoClaw rebuilt and restarted"
