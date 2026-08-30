# pi-config

Backup and setup repository for Pi Agent configuration, models, agent role definitions, and extensions.

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

2. Run the install script:
   ```bash
   cd ~/pi-config
   ./install.sh
   ```

3. Authenticate with your provider:
   ```bash
   # Log in to generate ~/.pi/agent/auth.json
   ```
