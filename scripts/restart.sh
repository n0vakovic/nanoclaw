#!/bin/bash
set -euo pipefail
# Restart the deployed artifact. Building is deliberately a separate action.
systemctl --user restart nanoclaw.service
echo "NanoClaw restarted (existing build)"
