import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertExactModel,
  collectAgentAttempt,
  loadRunner,
  parseJsonl,
  runAcceptance,
  runIsolatedAttempt,
  summarizeRows,
  validateBenchmarkRow,
} from '../scripts/benchmark-mechanic.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts/benchmark-mechanic.mjs');
const correctScore = 'export function clampScore(score) { return Math.max(0, Math.min(1, score)); }\n';

function benchmarkRow(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'benchmark',
    role: 'mechanic',
    task: 'discount-fix',
    requestedModel: 'provider/model',
    effectiveModel: 'provider/model',
    requestedThinking: 'high',
    effectiveThinking: 'high',
    elapsedMs: 125,
    tokens: null,
    costUsd: null,
    turns: 1,
    providerRetries: 0,
    correctiveAttempts: 0,
    failure: null,
    aborted: false,
    accepted: true,
    ...overrides,
  };
}

function makeWorkspace(t, task) {
  const root = mkdtempSync(join(tmpdir(), 'pi-benchmark-acceptance-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  if (task === 'discount-fix') {
    writeFileSync(join(workspace, 'src/discount.mjs'), 'export function applyDiscount(price, rate) { return price * (1 - rate); }\n');
  } else {
    writeFileSync(join(workspace, 'src/score.mjs'), correctScore);
  }
  return workspace;
}

const regressionTest = `import assert from 'node:assert/strict';
import test from 'node:test';
import { clampScore } from '../src/score.mjs';
test('fractional score is preserved', () => assert.equal(clampScore(0.5), 0.5));
`;

test('help and default CLI paths are offline; smoke and run require --live', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /smoke --live/);
  const defaultRun = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(defaultRun.status, 0);
  assert.match(defaultRun.stdout, /Usage:/);
  for (const command of ['smoke', 'run']) {
    const refused = spawnSync(process.execPath, [script, command], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /explicit --live consent/);
  }
  const helpWithoutConsent = spawnSync(process.execPath, [script, 'smoke', '--help'], { encoding: 'utf8' });
  assert.equal(helpWithoutConsent.status, 0);
});

test('summary aggregates by requested thinking and keeps unknown metrics explicit', () => {
  const summary = summarizeRows([
    benchmarkRow({ tokens: 10, costUsd: 0.2 }),
    benchmarkRow({ requestedThinking: 'max', effectiveThinking: 'max', accepted: false, tokens: null, costUsd: null, providerRetries: 2 }),
  ]);
  assert.deepEqual(summary.byThinking.map(group => group.thinking), ['high', 'max']);
  assert.equal(summary.byThinking[0].tokens.knownTotal, 10);
  assert.equal(summary.byThinking[0].tokens.unknownTrials, 0);
  assert.equal(summary.byThinking[1].tokens.knownTotal, null);
  assert.equal(summary.byThinking[1].tokens.unknownTrials, 1);
  assert.equal(summary.byThinking[1].costUsd.knownTotal, null);
  assert.deepEqual(summary.byThinking[1].providerRetries, { knownTrials: 1, unknownTrials: 0, knownTotal: 2 });
  assert.match(summary.note, /no quality or cost recommendation/);
});

test('summary preserves unknown turns and provider retries on terminated workers', () => {
  const summary = summarizeRows([
    benchmarkRow({ turns: null, providerRetries: null, aborted: true, accepted: false, failure: 'worker terminated' }),
    benchmarkRow({ turns: 2, providerRetries: 0 }),
  ]);
  assert.deepEqual(summary.byThinking[0].turns, { knownTrials: 1, unknownTrials: 1, knownTotal: 2 });
  assert.deepEqual(summary.byThinking[0].providerRetries, { knownTrials: 1, unknownTrials: 1, knownTotal: 0 });
});

test('JSONL parser rejects malformed rows and non-finite metrics', () => {
  assert.throws(() => parseJsonl('{not json}\n'), /Malformed JSONL at line 1/);
  assert.throws(() => parseJsonl(''), /empty/);
  assert.throws(() => validateBenchmarkRow(benchmarkRow({ elapsedMs: Infinity })), /finite and non-negative/);
  assert.throws(() => validateBenchmarkRow(benchmarkRow({ tokens: -1 })), /tokens must be null or finite/);
  assert.throws(() => validateBenchmarkRow({ ...benchmarkRow(), kind: 'smoke' }), /row.task === 'smoke'/);
});

test('worker fallback handles malformed schemas and timeout without inventing counters', { timeout: 2000 }, async () => {
  const payload = {
    kind: 'benchmark',
    fixture: { workspace: tmpdir(), role: 'mechanic', task: 'discount-fix', requestedModel: 'provider/model', requestedThinking: 'high' },
  };
  function worker(output) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    if (output !== null) queueMicrotask(() => {
      child.stdout.write(output);
      child.emit('close', 0);
    });
    return child;
  }
  for (const output of ['not json\n', '{}\n']) {
    const row = await runIsolatedAttempt(payload, 100, { spawnWorker: () => worker(output) });
    assert.match(row.failure, /Benchmark worker failed/);
    assert.equal(row.turns, null);
    assert.equal(row.providerRetries, null);
    assert.equal(row.accepted, false);
  }
  const timedOut = await runIsolatedAttempt(payload, 5, { spawnWorker: () => worker(null), hardKillGraceMs: 0 });
  assert.equal(timedOut.aborted, true);
  assert.match(timedOut.failure, /Wall timeout/);
  assert.equal(timedOut.turns, null);
  assert.equal(timedOut.providerRetries, null);
});

test('exact pinned model assertion rejects provider fallback', () => {
  assert.equal(assertExactModel('provider/model', { provider: 'provider', id: 'model' }), 'provider/model');
  assert.throws(() => assertExactModel('provider/model', { provider: 'other', id: 'model' }), /Pinned model mismatch/);
  assert.throws(() => assertExactModel('provider/model', null), /resolved none/);
});

test('injected trial captures effective session values, usage, turns, and provider retries', async () => {
  let listener;
  const fakeSession = {
    model: { provider: 'provider', id: 'model' },
    thinkingLevel: 'max',
    subscribe(callback) { listener = callback; return () => {}; },
    async dispose() {},
  };
  const row = benchmarkRow({ requestedThinking: 'high', task: 'discount-fix' });
  const result = await collectAgentAttempt({
    row,
    model: fakeSession.model,
    thinking: 'high',
    timeoutMs: 100,
    async invoke(callbacks) {
      callbacks.onSessionCreated(fakeSession);
      callbacks.onTurnEnd(3);
      callbacks.onAssistantUsage({ input: 4, output: 5, cacheRead: 3, cacheWrite: 1 });
      listener({ type: 'auto_retry_start', attempt: 1 });
      listener({ type: 'message_end', message: { role: 'assistant', usage: { input: 4, output: 5, cacheRead: 3, cacheWrite: 1, cost: { total: 0.12 } } } });
      return { responseText: 'ok', session: fakeSession, aborted: false };
    },
  });
  assert.equal(result.effectiveModel, 'provider/model');
  assert.equal(result.effectiveThinking, 'max');
  assert.equal(result.turns, 3);
  assert.equal(result.providerRetries, 1);
  assert.equal(result.correctiveAttempts, 0);
  assert.equal(result.tokens, 13);
  assert.equal(result.costUsd, 0.12);
  assert.equal(result.failure, null);
});

test('partial missing usage is not presented as a complete token or cost total', async () => {
  let listener;
  const fakeSession = {
    model: { provider: 'provider', id: 'model' }, thinkingLevel: 'high',
    subscribe(callback) { listener = callback; return () => {}; },
    async dispose() {},
  };
  const row = await collectAgentAttempt({
    row: benchmarkRow(), timeoutMs: 100,
    async invoke(callbacks) {
      callbacks.onSessionCreated(fakeSession);
      callbacks.onAssistantUsage({ input: 4, output: 5 });
      listener({ type: 'message_end', message: { role: 'assistant', usage: { cost: { total: 0.1 } } } });
      listener({ type: 'message_end', message: { role: 'assistant' } });
      return { session: fakeSession, responseText: 'ok', aborted: false };
    },
  });
  assert.equal(row.tokens, null);
  assert.equal(row.costUsd, null);
});

test('injected trial aborts at wall timeout and records failure without network', async () => {
  let aborted = false;
  const fakeSession = {
    model: { provider: 'provider', id: 'model' },
    thinkingLevel: 'high',
    subscribe() { return () => {}; },
    async abort() { aborted = true; },
    async dispose() {},
  };
  const row = benchmarkRow();
  const result = await collectAgentAttempt({
    row,
    model: fakeSession.model,
    thinking: 'high',
    timeoutMs: 15,
    invoke({ onSessionCreated }) {
      onSessionCreated(fakeSession);
      return new Promise(() => {});
    },
  });
  assert.equal(aborted, true);
  assert.equal(result.aborted, true);
  assert.match(result.failure, /Timed out after 15ms/);
  assert.equal(result.accepted, false);
  assert.equal(result.tokens, null);
  assert.equal(result.costUsd, null);
});

test('injected provider failure is recorded as a failed row', async () => {
  const fakeSession = {
    model: { provider: 'provider', id: 'model' },
    thinkingLevel: 'high',
    subscribe() { return () => {}; },
    async dispose() {},
  };
  const result = await collectAgentAttempt({
    row: benchmarkRow(), model: fakeSession.model, thinking: 'high', timeoutMs: 100,
    async invoke({ onSessionCreated }) {
      onSessionCreated(fakeSession);
      return { responseText: '', session: fakeSession, aborted: false, failure: 'provider overloaded' };
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.failure, 'provider overloaded');
});

test('live loader constructs a real SDK session offline and stops before any prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-benchmark-sdk-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(join(workspace, '.pi/agents'), { recursive: true });
  mkdirSync(agentDir);
  const role = readFileSync(join(repo, 'agent/agents/mechanic.md'), 'utf8')
    .replace('allowed_subagents: none', 'allowed_subagents: none\nextensions: false\nskills: false\npersist_session: false');
  writeFileSync(join(workspace, '.pi/agents/mechanic.md'), role);
  writeFileSync(join(agentDir, 'auth.json'), '{}');
  const setup = await loadRunner({
    root, workspace, agentDir,
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
  });
  const loaded = setup.modules.agentsModule.loadCustomAgents(workspace, false, { packageDirs: [], packageFiles: [] });
  setup.modules.typesModule.registerAgents(loaded);
  const model = setup.registry.getAll()[0];
  assert.ok(model, 'SDK has a locally known model; no authentication is needed before prompting');
  let session;
  await assert.rejects(setup.modules.runnerModule.runAgent({
    cwd: workspace, model, modelRegistry: setup.registry,
    getSystemPrompt: () => 'not inherited', isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => undefined },
  }, 'mechanic', 'This prompt must never be sent.', {
    model, thinkingLevel: 'high', maxTurns: 24,
    pi: { exec: async () => ({ code: 1, stdout: '', stderr: '' }) },
    onSessionCreated(value) { session = value; throw new Error('OFFLINE_STOP_BEFORE_PROMPT'); },
  }), /OFFLINE_STOP_BEFORE_PROMPT/);
  assert.ok(session);
  assert.equal(session.messages.length, 0);
  assert.ok(session.getActiveToolNames().includes('read'));
  assert.ok(!session.getActiveToolNames().includes('Agent'));
  session.dispose();
});

test('external acceptance accepts the correct discount fix and rejects its bug', t => {
  const correct = makeWorkspace(t, 'discount-fix');
  assert.deepEqual(runAcceptance('discount-fix', correct), { accepted: true, failure: null });
  const buggy = makeWorkspace(t, 'discount-fix');
  writeFileSync(join(buggy, 'src/discount.mjs'), 'export function applyDiscount(price, rate) { return price - rate; }\n');
  assert.equal(runAcceptance('discount-fix', buggy).accepted, false);
});

test('external regression acceptance requires a passing test that fails the known mutation', t => {
  const correct = makeWorkspace(t, 'fractional-regression');
  writeFileSync(join(correct, 'tests/score.test.mjs'), regressionTest);
  assert.deepEqual(runAcceptance('fractional-regression', correct), { accepted: true, failure: null });
  const missing = makeWorkspace(t, 'fractional-regression');
  assert.equal(runAcceptance('fractional-regression', missing).accepted, false);

  const ineffective = makeWorkspace(t, 'fractional-regression');
  writeFileSync(join(ineffective, 'tests/helper.mjs'), 'export const endpoint = 0;');
  writeFileSync(join(ineffective, 'tests/score.test.mjs'), `
    import assert from 'node:assert/strict';
    import test from 'node:test';
    import { endpoint } from './helper.mjs';
    import { clampScore } from '../src/score.mjs';
    // 0.5 is not actually covered: dependency loss must not fake mutation detection.
    test('endpoint only', () => assert.equal(clampScore(endpoint), endpoint));
  `);
  assert.equal(runAcceptance('fractional-regression', ineffective).accepted, false);

  const dependent = makeWorkspace(t, 'fractional-regression');
  writeFileSync(join(dependent, 'tests/helper.mjs'), 'export const fractional = 0.5;');
  writeFileSync(join(dependent, 'tests/score.test.mjs'), regressionTest
    .replace("import { clampScore }", "import { fractional } from './helper.mjs';\nimport { clampScore }")
    .replace('clampScore(0.5)', 'clampScore(fractional)'));
  assert.equal(runAcceptance('fractional-regression', dependent).accepted, true);
});
