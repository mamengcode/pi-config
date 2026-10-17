import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createSubagentsHarness, repo, writeAgentFile } from './helpers/subagents-runtime.mjs';

const rolesDir = join(repo, 'agent', 'agents');
const handoff = [
  'Assignment: inspect the supplied fixture and make only the requested change.',
  'Acceptance: run the stated checks and include command plus exit status in your handoff.',
].join('\n');

function fixtureExtension(name, tools = new Map()) {
  return { path: `/fixture/extensions/${name}.ts`, tools };
}

test('real role discovery honors package < global < workspace < project precedence', async t => {
  const h = await createSubagentsHarness(t);
  const packageDir = join(h.fixture.root, 'package-agents');
  const packageRole = join(packageDir, 'precedence.md');
  const globalRole = join(h.fixture.agentDir, 'agents', 'precedence.md');
  const workspaceRole = join(h.fixture.cwd, '.agents', 'agents', 'precedence.md');
  const projectRole = join(h.fixture.cwd, '.pi', 'agents', 'precedence.md');
  writeAgentFile(packageRole, 'precedence', 'model: package/model\n');
  writeAgentFile(globalRole, 'precedence', 'model: global/model\n');
  writeAgentFile(workspaceRole, 'precedence', 'model: workspace/model\n');
  writeAgentFile(projectRole, 'precedence', 'model: project/model\n');

  const agents = h.modules.agentsModule.loadCustomAgents(h.fixture.cwd, false, {
    packageDirs: [packageDir],
    packageFiles: [],
    packageExcluded: () => false,
  });
  const role = agents.get('precedence');
  assert.equal(role.model, 'project/model');
  assert.equal(role.source, 'project');
  assert.equal(role.sourcePath, projectRole);
  assert.equal(readFileSync(role.sourcePath, 'utf8'), readFileSync(projectRole, 'utf8'));

  // Removing the .pi winner proves the real loader falls through to its next tier.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(projectRole);
  const fallback = h.modules.agentsModule.loadCustomAgents(h.fixture.cwd, false, {
    packageDirs: [packageDir], packageFiles: [], packageExcluded: () => false,
  }).get('precedence');
  assert.equal(fallback.model, 'workspace/model');
  assert.equal(fallback.sourcePath, workspaceRole);
  unlinkSync(workspaceRole);
  const global = h.modules.agentsModule.loadCustomAgents(h.fixture.cwd, false, {
    packageDirs: [packageDir], packageFiles: [], packageExcluded: () => false,
  }).get('precedence');
  assert.equal(global.model, 'global/model');
  assert.equal(global.sourcePath, globalRole);
  unlinkSync(globalRole);
  const packaged = h.modules.agentsModule.loadCustomAgents(h.fixture.cwd, false, {
    packageDirs: [packageDir], packageFiles: [], packageExcluded: () => false,
  }).get('precedence');
  assert.equal(packaged.model, 'package/model');
  assert.equal(packaged.sourcePath, packageRole);
});

test('actual mechanic config pins model, high thinking, and 24 turns over conflicting call values', async t => {
  const h = await createSubagentsHarness(t, { roles: ['mechanic'], scripts: [{ text: 'bounded handoff' }] });
  const run = await h.invoke('mechanic', handoff, {
    model: 'alternate/conflict-model',
    thinking: 'max',
    max_turns: 0,
  });
  assert.equal(run.config.model, 'openai-codex/gpt-6-luna');
  assert.equal(run.config.thinking, 'high');
  assert.equal(run.config.maxTurns, 24);
  assert.equal(run.invocation.modelInput, run.config.model);
  assert.equal(run.invocation.thinking, 'high');
  assert.equal(run.invocation.maxTurns, 24);
  assert.equal(run.invocation.overridden.thinking, 'max');
  assert.equal(run.invocation.overridden.model, 'alternate/conflict-model');
  assert.equal(run.model.provider, 'openai-codex');
  assert.equal(run.model.id, 'gpt-6-luna');
  assert.equal(h.captures.sessionOptions[0].thinkingLevel, 'high');
  assert.equal(run.result.steered, false);
  await run.session.dispose();
});

test('all specialists resolve from installed role files without nested injected tools', async t => {
  const names = ['mechanic', 'implementer', 'planner', 'researcher', 'reviewer'];
  const h = await createSubagentsHarness(t, {
    roles: names,
    scripts: names.map(name => ({ text: `${name} handoff` })),
  });
  for (const name of names) {
    const run = await h.invoke(name, `${handoff}\nSpecialist: ${name}`, {}, {
      nestedRuntime: { manager: {}, parentAgentId: 'parent', depth: 0, maxSubagentDepth: 4 },
    });
    assert.equal(run.config.allowedSubagents, undefined, `${name} frontmatter disables nested delegation`);
    assert.deepEqual(h.captures.sessionOptions.at(-1).customTools, [], `${name} has no injected delegation tools`);
    assert.ok(!run.session.getAllTools().some(tool => ['Agent', 'get_subagent_result', 'steer_subagent'].includes(tool.name)));
    assert.equal(run.result.responseText, `${name} handoff`);
    await run.session.dispose();
  }
});

test('runner dynamically admits permitted late tools and blocks forbidden direct and nested calls', async t => {
  const permitted = new Map();
  const foreign = new Map();
  let h;
  h = await createSubagentsHarness(t, {
    extensions: [fixtureExtension('permitted', permitted), fixtureExtension('foreign', foreign)],
    scripts: [{
      text: 'late tool test',
      async onPrompt({ session }) {
        // prompt happens AFTER installExtensionToolScope; none existed at install.
        assert.equal(typeof session.agent.beforeToolCall, 'function');
        permitted.set('allowed_late', { name: 'allowed_late' });
        permitted.set('narrowed_out', { name: 'narrowed_out' });
        foreign.set('foreign_late', { name: 'foreign_late' });
        permitted.set('Agent', { name: 'Agent' });
        session.setActiveToolsByName(['read', 'allowed_late', 'narrowed_out', 'foreign_late', 'Agent']);
        const handlers = h.captures.loaders.at(-1).toolCallHandlers;
        assert.equal(handlers.length, 1, 'real inline scope-gate factory was executed');
        for (const name of ['allowed_late', 'narrowed_out', 'foreign_late', 'Agent']) {
          const direct = await session.agent.beforeToolCall({ toolCall: { name } }, new AbortController().signal);
          const nested = await handlers[0]({ toolName: name });
          if (name === 'allowed_late') {
            assert.equal(direct, undefined);
            assert.equal(nested, undefined);
          } else {
            assert.equal(direct.block, true, `direct call ${name}`);
            assert.equal(nested.block, true, `nested ctx.executeTool call ${name}`);
          }
        }
      },
    }],
  });
  writeAgentFile(
    join(h.fixture.cwd, '.pi', 'agents', 'late-scope.md'),
    'late-scope',
    'tools: read, ext:permitted/allowed_late\nextensions: true\nallowed_subagents: none\n',
  );
  const run = await h.invoke('late-scope', handoff);
  assert.deepEqual(run.session.getActiveToolNames().sort(), ['allowed_late', 'read']);
  await run.session.dispose();
});

test('read-only roles enforce their actual tool and extension restrictions', async t => {
  const names = ['planner', 'reviewer', 'researcher'];
  const h = await createSubagentsHarness(t, {
    roles: names,
    extensions: [fixtureExtension('rpiv-web-tools'), fixtureExtension('unrequested')],
    scripts: names.map(name => ({ text: `${name} report` })),
  });
  for (const name of names) {
    const run = await h.invoke(name, `${handoff}\nInvestigate without editing.`);
    const options = h.captures.sessionOptions.at(-1);
    const loaderOptions = h.captures.loaders.at(-1).options;
    const expectedTools = ['read', 'bash', 'grep', 'find', 'ls'];
    assert.deepEqual(run.config.builtinToolNames, expectedTools);
    if (name === 'researcher') {
      // Extensions need a live registry: the runner uses a denylist rather than
      // freezing tools at construction, so late web tools can still register.
      assert.equal(options.tools, undefined);
      assert.ok(options.excludeTools.includes('edit') && options.excludeTools.includes('write'));
      assert.equal(loaderOptions.noExtensions, false);
      assert.deepEqual(h.captures.loaders.at(-1).getExtensions().extensions.map(ext => ext.path), [
        '/fixture/extensions/rpiv-web-tools.ts',
      ]);
      assert.deepEqual(run.config.extSelectors, ['ext:rpiv-web-tools']);
    } else {
      assert.deepEqual(options.tools, expectedTools);
      assert.equal(loaderOptions.noExtensions, true);
      assert.deepEqual(h.captures.loaders.at(-1).getExtensions().extensions, []);
      assert.equal(run.config.extensions, false);
    }
    await run.session.dispose();
  }
});

test('replace-mode handoffs suppress parent context and automatic context files', async t => {
  const h = await createSubagentsHarness(t, { roles: ['mechanic'], scripts: [{ text: 'self-contained result' }] });
  const run = await h.invoke('mechanic', handoff);
  const loaderOptions = h.captures.loaders[0].options;
  assert.equal(run.config.promptMode, 'replace');
  assert.equal(run.session.promptText, handoff);
  assert.equal(loaderOptions.noContextFiles, true);
  assert.equal(loaderOptions.noPromptTemplates, true);
  assert.equal(loaderOptions.systemPromptOverride().includes('PARENT_SYSTEM_PROMPT_MUST_NOT_LEAK'), false);
  assert.match(loaderOptions.systemPromptOverride(), /self-contained/);
  assert.deepEqual(loaderOptions.appendSystemPromptOverride(), []);
  await run.session.dispose();
});

test('real runner classifies final provider errors and empty length stops as failures', async t => {
  for (const [script, expected] of [
    [{ text: 'partial provider output', stopReason: 'error', errorMessage: 'provider overloaded' }, /provider overloaded/],
    [{ text: '', stopReason: 'length' }, /output token limit/],
  ]) {
    const h = await createSubagentsHarness(t, { roles: ['mechanic'], scripts: [script] });
    const run = await h.invoke('mechanic', handoff);
    assert.match(run.result.failure, expected);
    await run.session.dispose();
  }
});

test('rejected prompt propagates and still leaves the runner session available for disposal', async t => {
  const h = await createSubagentsHarness(t, {
    roles: ['mechanic'],
    scripts: [{ reject: new Error('scripted prompt rejection') }],
  });
  await assert.rejects(h.invoke('mechanic', handoff), /scripted prompt rejection/);
  assert.equal(h.captures.sessions.length, 1);
  await h.captures.sessions[0].dispose();
});

test('mechanic receives the real soft-limit wrap-up steer at turn 24', async t => {
  const h = await createSubagentsHarness(t, { roles: ['mechanic'], scripts: [{ text: 'wrapped up', turns: 24 }] });
  const run = await h.invoke('mechanic', handoff);
  assert.equal(run.result.steered, true);
  assert.equal(run.result.aborted, false);
  assert.equal(run.session.steers.length, 1);
  assert.match(run.session.steers[0], /turn limit\. Wrap up immediately/);
  assert.ok(run.session.turnSnapshots.slice(0, 23).every(turn => turn.steers === 0 && turn.abortCalls === 0));
  assert.deepEqual(run.session.turnSnapshots[23], { turn: 24, steers: 1, abortCalls: 0 });
  await run.session.dispose();
});

test('mechanic is hard-aborted at turn 29 after the five-turn grace period', async t => {
  const h = await createSubagentsHarness(t, { roles: ['mechanic'], scripts: [{ text: 'partial after grace', turns: 29 }] });
  const run = await h.invoke('mechanic', handoff);
  assert.equal(run.result.steered, true);
  assert.equal(run.result.aborted, true);
  assert.equal(run.session.steers.length, 1);
  assert.equal(run.session.abortCalls, 1);
  assert.equal(run.result.responseText, 'partial after grace');
  assert.ok(run.session.turnSnapshots.slice(0, 23).every(turn => turn.steers === 0));
  assert.ok(run.session.turnSnapshots.slice(0, 28).every(turn => turn.abortCalls === 0));
  assert.deepEqual(run.session.turnSnapshots[23], { turn: 24, steers: 1, abortCalls: 0 });
  assert.deepEqual(run.session.turnSnapshots[27], { turn: 28, steers: 1, abortCalls: 0 });
  assert.deepEqual(run.session.turnSnapshots[28], { turn: 29, steers: 1, abortCalls: 1 });
  await run.session.dispose();
});

test('PROMPT contract carries a real failed validation into a bounded corrective handoff', async t => {
  let target;
  const h = await createSubagentsHarness(t, {
    roles: ['mechanic'],
    scripts: [
      { text: 'Reported complete, pending independent validation.' },
      {
        text: 'Corrected addition; rerun the required acceptance check.',
        onPrompt: () => writeFileSync(target, 'export const add = (a, b) => a + b;\n'),
      },
    ],
  });
  target = join(h.fixture.cwd, 'add.mjs');
  writeFileSync(target, 'export const add = (a, b) => a - b;\n');
  const check = () => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import assert from 'node:assert/strict';\nimport { add } from ${JSON.stringify(pathToFileURL(target).href)};\nassert.equal(add(2, 3), 5);`,
  ], { cwd: h.fixture.root, encoding: 'utf8', timeout: 5000 });
  const first = await h.invoke('mechanic', `${handoff}\nFix addition.`);
  const failed = check();
  assert.equal(failed.status, 1, 'reported completion is not acceptance');
  const corrected = await h.invoke('mechanic', [
    'Corrective attempt 1 of at most 2; fix only addition.',
    'Independent validation: node --input-type=module -e <addition assertion> exited 1.',
    failed.stderr,
    'Rerun validation; report a blocker instead of claiming completion if it still fails.',
  ].join('\n'));
  assert.match(corrected.session.promptText, /exited 1/);
  assert.match(corrected.session.promptText, /AssertionError/);
  assert.equal(check().status, 0, 'independent validation, not assistant text, accepts correction');
  for (const session of [first.session, corrected.session]) await session.dispose();
  // This is a scripted handoff scenario, not autonomous orchestrator enforcement.
});

test('PROMPT contracts pass a rejected review with validation evidence to a real corrective run', async t => {
  const outputs = [
    { text: 'Implemented the patch. `node --test` exited 0 (3 tests).' },
    { text: 'REJECTED: missing the empty-input regression. The implementation check passed but acceptance is incomplete.' },
    { text: 'Added the empty-input regression. `node --test` exited 0 (4 tests); exit status 0.' },
    { text: 'ACCEPTED: change and test are correct; validation evidence is complete.' },
  ];
  const h = await createSubagentsHarness(t, { roles: ['mechanic', 'reviewer'], scripts: outputs });
  const initial = await h.invoke('mechanic', `${handoff}\nDo the bounded patch.`);
  const rejected = await h.invoke('reviewer', [
    'Independently review the patch; reject missing edge cases.',
    'Changed file: src/target.mjs. Validation: node --test exited 0 (3 tests).',
    initial.result.responseText,
  ].join('\n'));
  const correctivePrompt = [
    'Correct only the finding below. Re-run validation and include the command and exit status.',
    rejected.result.responseText,
  ].join('\n');
  const corrected = await h.invoke('mechanic', correctivePrompt);
  const finalReview = await h.invoke('reviewer', [
    'Review the correction independently against the original acceptance criteria.',
    'Changed file: tests/target.test.mjs. Validation: node --test exited 0 (4 tests); exit status 0.',
    corrected.result.responseText,
  ].join('\n'));

  assert.match(rejected.result.responseText, /^REJECTED:/);
  assert.match(corrected.session.promptText, /REJECTED: missing the empty-input regression/);
  assert.match(corrected.session.promptText, /command and exit status/);
  assert.match(corrected.result.responseText, /node --test.*exited 0/);
  assert.match(finalReview.result.responseText, /^ACCEPTED:/);
  assert.match(readFileSync(join(rolesDir, 'mechanic.md'), 'utf8'), /at most two corrective retries/);
  assert.match(readFileSync(join(rolesDir, 'orchestrator.md'), 'utf8'), /at most two corrective retries per failing check/);
  assert.match(readFileSync(join(rolesDir, 'reviewer.md'), 'utf8'), /independent/);
  // The staged rejection/acceptance path checks only prompt/handoff contracts;
  // routing and retry-count enforcement remain orchestrator responsibilities.
  assert.equal(h.captures.sessions.length, 4);
  for (const session of h.captures.sessions) await session.dispose();
});
