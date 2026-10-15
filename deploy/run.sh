#!/bin/zsh
# Starts the built pipkin server. Secrets live in ~/.config/pipkin/env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source "${PIPKIN_ENV_FILE:-$HOME/.config/pipkin/env}"
set +a
export NODE_ENV=production
exec npx eve start --host 127.0.0.1 --port "${PORT:-4318}"
