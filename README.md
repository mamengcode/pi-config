# pi-config

Backup and configuration repository for Pi Agent settings, custom models, multi-agent roles, and extension packages.

## Repository Contents

- `agent/settings.json`: Global configuration, theme, default model, and package lists.
- `agent/AGENTS.md`: Global context guidance selecting the orchestrator role alongside project instructions.
- `agent/agents/`: Role prompts and supported pi-subagents configuration:

  | Role | Model | Thinking | Responsibility |
  | --- | --- | --- | --- |
  | orchestrator | gpt-6.1-sol | medium | Default user-facing orchestration, routing, integration, validation |
  | researcher | gpt-6.1-sol | medium | Read-only repository and external documentation research |
  | planner | gpt-6.1-sol | high | Read-only detailed implementation plans |
  | implementer | gpt-6-luna | xhigh | Execute a plan or assigned slice |
  | reviewer | gpt-6.1-sol | high | Independent read-only implementation review |
  | mechanic | gpt-6-luna | high | Bounded easy/direct, repetitive, or long-running execution |
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

## Multi-agent Workflow

Start Pi normally: the main session reads global `AGENTS.md` guidance and loads
the orchestrator role from `agents/orchestrator.md`. `settings.json` supplies its
startup model (`openai-codex/gpt-6.1-sol`) and thinking level (`medium`). This is a
native instruction-based default, not a named-primary-agent selector; no
`pi-open-agents` extension or RPIV pipeline is required.

Orchestrator chooses only the stages needed:

- Missing context: researcher -> orchestrator synthesis.
- Non-trivial implementation: optional researcher -> planner -> implementer -> reviewer.
- Easy/direct or long-running mechanical work: mechanic -> validation; review when risk warrants it.
- Research-only, plan-only, or review-only requests stop at the requested output.

A clear implementation request authorizes in-scope execution without a routine
second plan approval. Material ambiguity, scope changes, and explicit approval
requests still require user input. Orchestrator supplies self-contained handoffs,
checks the actual diff, integrates results, and resolves substantive review findings.
Specialists do not delegate. Model/thinking pins apply to named subagent calls;
main-session defaults can still be overridden by CLI/model selection.

Assignments default to a 24-model-turn working budget and at most two corrective
retries per failing check, each supported by a concrete diagnosis. Orchestrator
passes a finite turn limit for roles without a pinned one. Mechanic pins
`max_turns: 24`: role frontmatter wins over call arguments, so callers cannot
raise or lower that limit. Pi-subagents requests wrap-up at turn 24 and aborts
after its grace period (five additional turns by default). Larger jobs should be
split into resumable batches; time waiting for a command is not a retry budget.
Mechanic's `high` thinking setting is provisional, not a measured cost saving.
Completion evidence records validation, corrective retries, accepted/blocked
outcome, and elapsed/token metrics when available (otherwise explicitly unknown).

Researcher, planner, and reviewer omit write/edit tools; bash remains an inspection
capability, not a filesystem sandbox. Their prompts explicitly prohibit mutation.
Specialists use standalone replacement prompts: the runner suppresses automatic
AGENTS/append-system loading, and parent conversation inheritance defaults off.
Handoffs must therefore include the objective, constraints, acceptance checks,
pre-existing diff, and applicable guidance paths for the specialist to read.
Use `@researcher <question>` or another role mention for an explicit specialist
request, or let the main orchestrator choose through the Agent tool.

The installer links global guidance alongside settings and agents and honors
`PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Restart Pi after installing these
changes. Global context is loaded alongside project context: a project's
`.pi/APPEND_SYSTEM.md` or project-local `AGENTS.override.md` does not remove the
orchestrator guidance. This remains an instruction-based default, not a sandbox
or an enforcement mechanism against conflicting user instructions.

Installation refuses to overwrite or shadow existing global guidance files or
replace an unmanaged `agents` path, including foreign/dangling symlinks. These
checks run before managed settings are changed or npm is invoked. Back up or
relocate conflicting paths and merge definitions deliberately, or choose an
empty `PI_CODING_AGENT_DIR`. An exact repository-managed agents symlink is left
untouched on repeat installs. The installer removes only the old
repository-managed `APPEND_SYSTEM.md` symlink, preserving user-owned append files
and symlinks.

### Offline regression checks

Run `node --test tests/*.test.mjs` after installing dependencies and Pi. The tests
make no model calls or package installations:

- `tests/startup.test.mjs` uses the real Pi resource loader and mocked npm to
  check startup, project overrides, repeatable migration, and preservation of
  user-owned guidance and agent definitions.
- `tests/delegation.test.mjs` loads real installed pi-subagents source via jiti
  with a mocked SDK session/resource boundary. It checks discovery and config
  precedence, model/thinking/tool settings, context suppression, nested-tool
  gating, provider failures, and turn-limit steering/abort. Scripted validation
  and review-to-fix scenarios exercise handoff plumbing, not autonomous model
  compliance. Retry/review routing remains an instruction policy, while the
  runtime enforces the turn limit with its grace period.
- `tests/benchmark.test.mjs` checks consent guards, metric summaries, timeout
  capture, external acceptance/mutation checks, and real SDK session construction
  stopped before prompting (no provider call).

Fixtures use temporary directories, not your active configuration. These tests
do not prove provider availability, thinking clamping, or full SDK tool-registry
behavior. Managed Pi installations are discovered automatically. For other
layouts, set `PI_TEST_PI_PACKAGE` to the Pi package directory or its JavaScript
entrypoint. The runtime tests require the installed extension dependencies in
`agent/npm/node_modules`; missing dependencies fail rather than silently skip.

### Optional live smoke and mechanic benchmark

These commands **make paid/provider calls only with `--live`**. Authenticate with
Pi first. A smoke test checks the exact pinned model and a fixed response marker;
it refuses model/provider fallback. Other roles can be checked with `--role`.

```bash
node scripts/benchmark-mechanic.mjs --help
node scripts/benchmark-mechanic.mjs smoke --live --role mechanic
node scripts/benchmark-mechanic.mjs smoke --live --role reviewer
mkdir -p .pi-benchmarks
node scripts/benchmark-mechanic.mjs run --live --output .pi-benchmarks/mechanic.jsonl
node scripts/benchmark-mechanic.mjs summary .pi-benchmarks/mechanic.jsonl
```

`run` makes four single-shot trials: two identical fresh tasks at each of `high`
and `max` thinking. One fixes fractional discounts; the other adds a regression
that must pass correct code and fail a known rounding mutation by assertion.
The acceptance driver is outside the agent working directory. JSONL records
requested/effective model and thinking, elapsed time, tokens/cost, turns, provider
retries, corrective attempts (zero for these single-shot trials), failures, and
independent acceptance. Unknown observations stay `null`, including counters from
terminated workers; summaries separate known totals from missing observations.
There is no automatic cost/quality recommendation. Two tasks and one trial per
setting are a starting sample, not proof of general superiority; repeat with
fresh output files before changing defaults. `--output` refuses existing files.

Each attempt has a default two-minute wall timeout (`--timeout-ms` overrides it),
a 24-turn working budget, and the runtime's five-turn wrap-up grace. Worker
shutdown has an additional bounded grace. The benchmark overrides thinking only
in temporary role copies, never your real configuration. Live diagnostics disable
extensions/skills and persistent sessions, so smoke is not a full extension test.
Credentials are copied privately into temporary storage; SDK OAuth refreshes can
update that copy, not active auth. Custom model definitions are read from the
active agent directory. Temporary resources are removed after each attempt.
This is workspace separation, **not an OS sandbox**: model shell tools can still
access your account's files/network. Run live trials only where that is acceptable.
No live smoke or cost benchmark is part of the default offline tests.

## Updating and Pushing Changes

Because `~/.pi/agent` files are symlinked directly to this repo, any configuration changes are instantly reflected here. To push changes:

```bash
cd ~/pi-config
git diff
git commit -am "update: config or agent prompts"
git push
```
