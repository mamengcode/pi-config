#!/usr/bin/env bash
set -e

PI_TARGET_DIR="${HOME}/.pi/agent"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent"

echo "==> Setting up Pi configuration symlinks in ${PI_TARGET_DIR}..."
mkdir -p "${PI_TARGET_DIR}/config" "${PI_TARGET_DIR}/npm"

# Create symlinks to repository files
ln -sf "${REPO_DIR}/settings.json" "${PI_TARGET_DIR}/settings.json"
ln -sf "${REPO_DIR}/models-store.json" "${PI_TARGET_DIR}/models-store.json"
rm -rf "${PI_TARGET_DIR}/agents"
ln -s "${REPO_DIR}/agents" "${PI_TARGET_DIR}/agents"
ln -sf "${REPO_DIR}/config/pi-task-models.json" "${PI_TARGET_DIR}/config/pi-task-models.json"
ln -sf "${REPO_DIR}/npm/package.json" "${PI_TARGET_DIR}/npm/package.json"
if [ -f "${REPO_DIR}/npm/package-lock.json" ]; then
  ln -sf "${REPO_DIR}/npm/package-lock.json" "${PI_TARGET_DIR}/npm/package-lock.json"
fi

# Install extension dependencies
echo "==> Installing Pi extension packages..."
(cd "${PI_TARGET_DIR}/npm" && npm install --omit=dev)

# Patch pi-open-agents to use Alt+A for cycling agents (fixes macOS/terminal Ctrl+Shift+M collision)
SELECTOR_FILE="${PI_TARGET_DIR}/npm/node_modules/pi-open-agents/src/tui/selector.ts"
if [ -f "$SELECTOR_FILE" ]; then
  echo "==> Applying Alt+A shortcut patch to pi-open-agents..."
  sed -i '' 's/Key.ctrlShift("m")/Key.alt("a")/g' "$SELECTOR_FILE" 2>/dev/null || \
  sed -i 's/Key.ctrlShift("m")/Key.alt("a")/g' "$SELECTOR_FILE" 2>/dev/null || true
fi

echo ""
echo "==> Installation and symlinking complete!"
echo "NOTE: Remember to authenticate with your provider (e.g. via Pi CLI / auth flow) to create ~/.pi/agent/auth.json."
