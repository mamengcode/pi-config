# pi-config

Backup and configuration repository for Pi Agent settings, custom models, multi-agent roles, and extension packages.

## Repository Contents

- `agent/settings.json`: Global configuration, theme, default model, and package lists.
- `agent/models-store.json`: Custom models catalog and endpoints.
- `agent/agents/`: Multi-agent system role prompts and permissions:
  - `coordinator.md`
  - `direct-implementer.md`
  - `implementer.md`
  - `planner.md`
  - `reviewer.md`
- `agent/config/pi-task-models.json`: Task-to-profile routing mappings.
- `agent/npm/`: Extensions manifest (`package.json`, `package-lock.json`).

## Setup on a New Computer

1. Clone this repository:
   ```bash
   git clone git@github.com:mamengcode/pi-config.git ~/pi-config
   ```

2. Run the installer (creates symlinks into `~/.pi/agent` and installs npm packages):
   ```bash
   cd ~/pi-config
   ./install.sh
   ```

3. Authenticate with your provider:
   ```bash
   # Authenticate with Pi to generate ~/.pi/agent/auth.json
   ```

## Updating and Pushing Changes

Because `~/.pi/agent` files are symlinked directly to this repo, any configuration changes are instantly reflected here. To push changes:

```bash
cd ~/pi-config
git diff
git commit -am "update: config or agent prompts"
git push
```
