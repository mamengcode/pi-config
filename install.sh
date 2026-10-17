#!/usr/bin/env bash
set -e

PI_TARGET_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent"

echo "==> Setting up Pi configuration symlinks in ${PI_TARGET_DIR}..."

# Refuse to hide or overwrite existing global guidance. Pi selects the first
# matching context filename in a directory, so alternate names matter too.
for name in AGENTS.override.md AGENTS.md AGENTS.MD CLAUDE.md CLAUDE.MD; do
  target="${PI_TARGET_DIR}/${name}"
  if [ -e "${target}" ] || [ -L "${target}" ]; then
    # AGENTS.MD may resolve to AGENTS.md on case-insensitive filesystems.
    if [ -L "${target}" ] && \
      [ "$(readlink "${target}")" = "${REPO_DIR}/AGENTS.md" ]; then
      continue
    fi
    echo "Refusing to replace or shadow existing global guidance: ${target}" >&2
    echo "Merge or back it up before installing the orchestrator guidance." >&2
    exit 1
  fi
done

# Never replace an unmanaged agent directory, file, or symlink. In particular,
# test -L as well as -e so dangling symlinks are treated as existing paths.
agents_target="${PI_TARGET_DIR}/agents"
if [ -e "${agents_target}" ] || [ -L "${agents_target}" ]; then
  if [ ! -L "${agents_target}" ] || \
    [ "$(readlink "${agents_target}")" != "${REPO_DIR}/agents" ]; then
    echo "Refusing to replace existing agent definitions: ${agents_target}" >&2
    echo "Back it up or relocate it, merge any agent definitions into ${REPO_DIR}/agents, then rerun; alternatively choose an empty PI_CODING_AGENT_DIR. Nothing was changed." >&2
    exit 1
  fi
fi

mkdir -p "${PI_TARGET_DIR}/config" "${PI_TARGET_DIR}/npm"

# Create symlinks to repository files.
ln -sf "${REPO_DIR}/AGENTS.md" "${PI_TARGET_DIR}/AGENTS.md"
ln -sf "${REPO_DIR}/settings.json" "${PI_TARGET_DIR}/settings.json"

# Remove only our obsolete startup symlink; preserve user-owned append prompts.
if [ -L "${PI_TARGET_DIR}/APPEND_SYSTEM.md" ] && \
  [ "$(readlink "${PI_TARGET_DIR}/APPEND_SYSTEM.md")" = "${REPO_DIR}/APPEND_SYSTEM.md" ]; then
  rm "${PI_TARGET_DIR}/APPEND_SYSTEM.md"
fi
if [ ! -e "${agents_target}" ] && [ ! -L "${agents_target}" ]; then
  ln -s "${REPO_DIR}/agents" "${agents_target}"
fi
ln -sf "${REPO_DIR}/config/pi-task-models.json" "${PI_TARGET_DIR}/config/pi-task-models.json"
ln -sf "${REPO_DIR}/npm/package.json" "${PI_TARGET_DIR}/npm/package.json"
if [ -f "${REPO_DIR}/npm/package-lock.json" ]; then
  ln -sf "${REPO_DIR}/npm/package-lock.json" "${PI_TARGET_DIR}/npm/package-lock.json"
fi

# Install extension dependencies
echo "==> Installing Pi extension packages..."
(cd "${PI_TARGET_DIR}/npm" && npm install --omit=dev)

echo ""
echo "==> Installation and symlinking complete!"
echo "NOTE: Remember to authenticate with your provider (e.g. via Pi CLI / auth flow) to create ~/.pi/agent/auth.json."
