#!/bin/zsh
# Builds pipkin and installs it as a launchd user agent (dev.pipkin).
# Requires: Node 24+, the Codex CLI signed in with ChatGPT (`codex login`),
# and ~/.config/pipkin/env with the GitHub App credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
PIPKIN_DIR=$PWD
ENV_FILE="$HOME/.config/pipkin/env"

command -v codex >/dev/null || { echo "Install the Codex CLI first." >&2; exit 1; }
codex login status 2>&1 | grep -q ChatGPT || { echo "Run 'codex login' with your ChatGPT account first." >&2; exit 1; }
[[ -f $ENV_FILE ]] || { echo "Create $ENV_FILE from deploy/env.example first." >&2; exit 1; }
chmod 600 "$ENV_FILE"

npm ci
npx eve build

PLIST="$HOME/Library/LaunchAgents/dev.pipkin.plist"
sed -e "s|__PIPKIN_DIR__|$PIPKIN_DIR|g" -e "s|__HOME__|$HOME|g" deploy/launchd.plist.template > "$PLIST"
launchctl bootout "gui/$(id -u)/dev.pipkin" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "pipkin installed. Logs: ~/Library/Logs/pipkin.log"
