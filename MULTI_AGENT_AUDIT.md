# Multi-agent workflow audit

Audited the current working tree, including the uncommitted role migration. This is a configuration/source audit, not a benchmark of model quality or live task success. The original audit changed no workflow configuration; implementation follow-through is recorded below.

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

## Implementation follow-through

All three recommendations now have implementation coverage:

1. **Delegation regression tests:** `tests/delegation.test.mjs` and its fixture helper exercise the real extension runner with a mocked session boundary. Coverage includes every discovery tier, configuration precedence, standalone context, static/dynamic/nested tool gates, provider failures, exact turn-limit boundaries, independent failed-validation handoffs, and scripted review/correction. Routing/retry compliance remains an instruction contract, not a newly enforced runtime state machine.
2. **Bounded execution and measurement:** mechanic now requests provisional `high` thinking and pins a 24-turn working budget (wrap-up at 24, abort after the default five-turn grace). Orchestrator and mechanic specify two corrective retries, escalation, resumable batches, explicit context handoffs, and observed/unknown metrics. `scripts/benchmark-mechanic.mjs` provides opt-in live smoke, a two-task high/max comparison, and an offline JSONL summary. Acceptance checks preserve dependencies and require a real assertion failure under mutation; missing metrics are not invented.
3. **Non-destructive installation:** unmanaged agent directories, files, and foreign/dangling symlinks are refused before managed mutations or npm. Existing managed links remain untouched. Startup regressions cover preservation and repeat installation.

Implementation validation: `node --test tests/*.test.mjs` passed all **31** offline tests; `node --check scripts/benchmark-mechanic.mjs`, `bash -n install.sh`, and whitespace checks passed. Independent review of installer/budget, delegation coverage, and benchmark corrections finished **READY**.

Run `node --test tests/*.test.mjs` for offline checks. See `README.md` for live commands, authentication/isolation details, and limitations. No live provider smoke or empirical cost comparison was run during implementation, so lower cost or equal model quality is **not** claimed. The lower-thinking default remains provisional until measured.
