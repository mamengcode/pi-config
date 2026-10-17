# Multi-agent workflow audit

Audited the current working tree, including the uncommitted role migration. This is a configuration/source audit, not a benchmark of model quality or live task success. No workflow configuration was changed.

## Overall assessment

The architecture is sensible: one orchestrator owns decisions and integration, specialists have explicit boundaries, and substantive changes receive independent review. Keep that structure. The largest gains are in proving runtime behavior, controlling execution cost, and protecting local configuration—not adding more agents.

## Highest-impact improvements

### 1. Test delegation, not just startup

**Evidence:** `tests/startup.test.mjs:54–68` loads Pi with no packages and `noExtensions: true`. Its assertions establish that global guidance is present, not that specialists launch with the intended model, thinking level, tools, or delegation restrictions.

**Improve:** Add a deterministic integration suite using the real subagent extension with a mocked model/process boundary. Cover role discovery, effective model/thinking/tool settings, forbidden nested delegation, failed validation, and review-to-fix handoffs. Explicitly test standalone specialist context: the installed runner suppresses automatic AGENTS/APPEND_SYSTEM loading, so self-contained handoffs and specialists reading repository guidance are essential (`@tintinweb/pi-subagents/src/agent-runner.ts:758–762`). Keep a separate optional live smoke test for provider/model availability.

**Payoff:** Catch broken orchestration contracts before discovering them during real implementation. Existing startup tests remain useful; they cover a different layer.

### 2. Make the economical route genuinely bounded

**Evidence:** Orchestrator describes mechanic as the economical route (`agent/agents/orchestrator.md:27–30`), but mechanic requests `thinking: max` and pins `max_turns: 0` (`agent/agents/mechanic.md:4–6`). In installed pi-subagents 0.22.0, zero means unlimited (`src/agent-runner.ts:369–390`), and role settings override Agent-call arguments (`src/invocation-config.ts:135–140`). A finite `max_turns` on a mechanic call therefore cannot override this pinned zero. The orchestrator also specifies no explicit per-assignment attempt or cost budget.

**Improve:** Remove the pinned zero so finite per-call turn limits can work, or replace it with a finite role limit. Benchmark a lower-thinking mechanic default against representative repetitive edits and test runs. Give each assignment a retry budget and escalation condition; distinguish waiting for a long-running command from spending more model turns. Record elapsed time, token usage, retries, and accepted outcomes to tune the route empirically.

**Payoff:** Avoid requesting the highest thinking level on the easiest work (subject to model clamping) or letting a supposedly cheap assignment expand indefinitely. Lower thinking is a hypothesis to measure, not a guaranteed saving.

### 3. Preserve user-owned agents during installation

**Evidence:** `install.sh:35–36` unconditionally removes the target `agents` directory before linking the managed one. A temporary-directory reproduction with mocked npm exited successfully while deleting an existing `agents/custom.md`. Guidance files receive conflict protection, but agent definitions do not.

**Improve:** Replace only the recognized repository-managed symlink. Refuse an unmanaged directory or different symlink and offer an explicit backup/migration path. Add regression cases for user-owned directories, alternate symlinks, and repeat installation.

**Payoff:** Prevent irreversible loss of custom specialists during setup or migration.

## Validation

- `node --test tests/startup.test.mjs`: all 5 tests passed.
- `bash -n install.sh`: passed.
- Installer deletion reproduced only in an isolated temporary directory; npm was mocked and no packages were installed.
- Runtime findings checked against installed `@tintinweb/pi-subagents` 0.22.0 source under `agent/npm/node_modules/`; no live model calls were used to test delegation behavior.
- Existing uncommitted changes were preserved.
