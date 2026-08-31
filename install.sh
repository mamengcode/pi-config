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

# 2. Install extension dependencies and run patches
echo "==> Installing Pi extension packages..."
(cd "${PI_TARGET_DIR}/npm" && npm install --omit=dev)

echo "==> Applying patches to pi-open-agents..."
node "${REPO_DIR}/npm/patch-open-agents.js"

echo ""
echo "==> Installation and symlinking complete!"
echo "NOTE: Remember to authenticate with your provider (e.g. via Pi CLI / auth flow) to create ~/.pi/agent/auth.json."
