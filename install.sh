#!/usr/bin/env bash
set -e

PI_TARGET_DIR="${HOME}/.pi/agent"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent"

echo "==> Setting up Pi configuration in ${PI_TARGET_DIR}..."
mkdir -p "${PI_TARGET_DIR}/config" "${PI_TARGET_DIR}/npm"

# Copy global settings, models, and task profiles
cp "${REPO_DIR}/settings.json" "${PI_TARGET_DIR}/"
cp "${REPO_DIR}/models-store.json" "${PI_TARGET_DIR}/"
cp -R "${REPO_DIR}/agents" "${PI_TARGET_DIR}/"
cp -R "${REPO_DIR}/config/"* "${PI_TARGET_DIR}/config/"

# Copy npm extension manifest & lockfile
cp "${REPO_DIR}/npm/package.json" "${PI_TARGET_DIR}/npm/"
if [ -f "${REPO_DIR}/npm/package-lock.json" ]; then
  cp "${REPO_DIR}/npm/package-lock.json" "${PI_TARGET_DIR}/npm/"
fi

# Install extensions
echo "==> Installing Pi extension packages..."
(cd "${PI_TARGET_DIR}/npm" && npm install --omit=dev)

echo ""
echo "==> Installation complete!"
echo "NOTE: Remember to authenticate with your provider (e.g. via Pi CLI / auth flow) to create ~/.pi/agent/auth.json."
