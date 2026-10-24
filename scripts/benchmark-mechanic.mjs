#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const extensionRoot = join(repoRoot, 'agent/npm/node_modules/@tintinweb/pi-subagents');
const localRequire = createRequire(join(repoRoot, 'agent/npm/package.json'));
const DEFAULT_TIMEOUT_MS = 120_000;
const HARD_KILL_GRACE_MS = 5_000;
const ACCEPTANCE_TIMEOUT_MS = 5_000;
const SMOKE_MARKER = 'PI_MECHANIC_SMOKE_7F3A';
const THINKING_LEVELS = ['high', 'max'];

const TASKS = {
  'discount-fix': {
    prompt: [
      'Fix the bug in src/discount.mjs. applyDiscount(price, rate) treats rate as a currency amount, but rate is a decimal fraction.',
      'Return price * (1 - rate), including fractional rates and endpoints 0 and 1. Do not add unrelated files.',
    ].join('\n'),
    initial: 'export function applyDiscount(price, rate) { return price - rate; }\n',
  },
  'fractional-regression': {
    prompt: [
      'Add a focused regression test at tests/score.test.mjs proving clampScore(0.5) is exactly 0.5.',
      'Do not change src/score.mjs. The external acceptance check also verifies your test fails against a known buggy mutation.',
    ].join('\n'),
    initial: 'export function clampScore(score) { return Math.max(0, Math.min(1, score)); }\n',
  },
};

const VALIDATION_DRIVER = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.PI_BENCH_WORKSPACE;
const task = process.env.PI_BENCH_TASK;
if (task === 'discount-fix') {
  const { applyDiscount } = await import(pathToFileURL(join(workspace, 'src/discount.mjs')).href + '?acceptance=1');
  assert.equal(typeof applyDiscount, 'function', 'applyDiscount must be exported');
  for (const [price, rate, expected] of [[100, 0.25, 75], [25, 0, 25], [25, 1, 0], [0.6, 0.5, 0.3]]) {
    assert.ok(Math.abs(applyDiscount(price, rate) - expected) < 1e-10, 'applyDiscount(' + price + ', ' + rate + ') must equal ' + expected);
  }
} else if (task === 'fractional-regression') {
  const expectedSource = 'export function clampScore(score) { return Math.max(0, Math.min(1, score)); }';
  assert.equal(readFileSync(join(workspace, 'src/score.mjs'), 'utf8').trim(), expectedSource, 'the benchmark task must leave the implementation unchanged');
  const testFile = join(workspace, 'tests/score.test.mjs');
  const testSource = readFileSync(testFile, 'utf8');
  assert.match(testSource, /clampScore\s*\(/, 'regression test must exercise clampScore');
  assert.match(testSource, /0\.5/, 'regression test must cover the fractional value 0.5');
  assert.match(testSource, /assert\.(?:equal|strictEqual)\s*\(/, 'regression test must assert an exact result');
  const runTest = cwd => spawnSync(process.execPath, ['--test-reporter=tap', '--test', 'tests/score.test.mjs'], {
    cwd, encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024,
  });
  const correct = runTest(workspace);
  assert.equal(correct.status, 0, 'regression test must pass on correct code:\n' + correct.stdout + '\n' + correct.stderr);
  assert.match(correct.stdout, /# tests\s+[1-9]\d*/, 'at least one regression test must execute');

  const mutant = mkdtempSync(join(tmpdir(), 'pi-benchmark-mutant-'));
  try {
    // Preserve local test helpers/dependencies: only the implementation changes.
    cpSync(workspace, mutant, { recursive: true });
    writeFileSync(join(mutant, 'src/score.mjs'), 'export function clampScore(score) { return Math.max(0, Math.min(1, Math.round(score))); }');
    const mutated = runTest(mutant);
    assert.equal(mutated.error, undefined, 'mutation check must finish, not time out');
    assert.equal(mutated.signal, null, 'mutation check must not be terminated');
    assert.equal(mutated.status, 1, 'regression test must fail against the known buggy rounding mutation');
    assert.match(mutated.stdout, /code: ['"]ERR_ASSERTION['"]/, 'mutation must produce a genuine assertion failure, not a missing dependency or syntax error');
  } finally {
    rmSync(mutant, { recursive: true, force: true });
  }
} else {
  throw new Error('Unknown validation task');
}
console.log('ACCEPTED');
`;

export function validateBenchmarkRow(row) {
  assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'JSONL row must be an object');
  assert.equal(row.schemaVersion, 1, 'unsupported benchmark row schemaVersion');
  assert.ok(['benchmark', 'smoke'].includes(row.kind), 'kind must be benchmark or smoke');
  assert.equal(typeof row.role, 'string');
  assert.ok(row.role.length > 0, 'role must not be empty');
  assert.equal(typeof row.requestedModel, 'string');
  assert.ok(row.requestedModel.length > 0, 'requestedModel must not be empty');
  assert.ok(row.effectiveModel === null || typeof row.effectiveModel === 'string');
  assert.ok(row.requestedThinking === null || typeof row.requestedThinking === 'string');
  assert.ok(row.effectiveThinking === null || typeof row.effectiveThinking === 'string');
  for (const key of ['elapsedMs', 'correctiveAttempts']) {
    assert.equal(typeof row[key], 'number', `${key} must be a number`);
    assert.ok(Number.isFinite(row[key]) && row[key] >= 0, `${key} must be finite and non-negative`);
  }
  assert.ok(Number.isInteger(row.correctiveAttempts), 'correctiveAttempts must be an integer');
  for (const key of ['turns', 'providerRetries']) {
    assert.ok(row[key] === null || (Number.isInteger(row[key]) && row[key] >= 0), `${key} must be null or a non-negative integer`);
  }
  for (const key of ['tokens', 'costUsd']) {
    assert.ok(row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0), `${key} must be null or finite and non-negative`);
  }
  assert.equal(typeof row.aborted, 'boolean');
  assert.equal(typeof row.accepted, 'boolean');
  assert.ok(row.failure === null || typeof row.failure === 'string');
  if (row.accepted) assert.ok(!row.aborted && row.failure === null, 'accepted rows cannot be aborted or failed');
  if (row.kind === 'benchmark') {
    assert.ok(Object.hasOwn(TASKS, row.task), 'benchmark task is unknown');
    assert.ok(THINKING_LEVELS.includes(row.requestedThinking), 'benchmark thinking must be high or max');
  } else {
    assert.ok(row.task === 'smoke');
  }
  return row;
}

export function assertExactModel(requested, model) {
  const effective = model && typeof model.provider === 'string' && typeof model.id === 'string'
    ? `${model.provider}/${model.id}`
    : null;
  if (!effective || effective.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(`Pinned model mismatch: requested ${requested}, resolved ${effective ?? 'none'}`);
  }
  return effective;
}

/** Run an injected real/fake runner with an abort signal, wall timeout, and metric capture. */
export async function collectAgentAttempt({ row, model, thinking, timeoutMs, invoke }) {
  const started = performance.now();
  const controller = new AbortController();
  let session;
  let unsubscribe;
  let timeoutHit = false;
  let turnCount = 0;
  let providerRetries = 0;
  let usageSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costKnown = false;
  let costIncomplete = false;
  let usageIncomplete = false;
  let costUsd = 0;

  const observeSession = value => {
    if (!value || session === value) return;
    session = value;
    if (value.model) row.effectiveModel = `${value.model.provider}/${value.model.id}`;
    if (typeof value.thinkingLevel === 'string') row.effectiveThinking = value.thinkingLevel;
    unsubscribe = value.subscribe?.(event => {
      if (event.type === 'auto_retry_start') providerRetries++;
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const total = event.message.usage?.cost?.total;
        if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
          costKnown = true;
          costUsd += total;
        } else {
          costIncomplete = true;
        }
        if (![event.message.usage?.input, event.message.usage?.output]
          .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) usageIncomplete = true;
      }
    });
    if (timeoutHit) void value.abort?.();
  };

  const call = Promise.resolve().then(() => invoke({
    signal: controller.signal,
    onSessionCreated: observeSession,
    onTurnEnd: count => { turnCount = count; },
    onAssistantUsage: usage => {
      const fields = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0];
      if (!fields.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return;
      usageSeen = true;
      inputTokens += fields[0];
      outputTokens += fields[1];
      cacheReadTokens += fields[2];
      cacheWriteTokens += fields[3];
    },
  })).then(result => ({ result }), error => ({ error }));

  let timer;
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => {
      timeoutHit = true;
      controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
      void session?.abort?.();
      resolveTimeout({ timedOut: true });
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([call, timeout]);
    if (outcome.timedOut) {
      row.failure = `Timed out after ${timeoutMs}ms`;
      row.aborted = true;
    } else if (outcome.error) {
      row.failure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      row.aborted = controller.signal.aborted;
    } else {
      const result = outcome.result;
      if (result?.session) observeSession(result.session);
      row.failure = result?.failure ?? null;
      row.aborted = Boolean(result?.aborted);
      row.responseText = typeof result?.responseText === 'string' ? result.responseText : '';
    }
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    if (session?.dispose) {
      await Promise.race([
        Promise.resolve(session.dispose()).catch(() => {}),
        new Promise(resolveDispose => setTimeout(resolveDispose, 500)),
      ]);
    }
    row.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  }

  row.turns = session ? turnCount : null;
  row.providerRetries = session ? providerRetries : null;
  row.tokens = usageSeen && !usageIncomplete ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens : null;
  row.costUsd = costKnown && !costIncomplete ? costUsd : null;
  // A timeout or resolved provider/runner failure is never acceptance.
  if (row.aborted || row.failure) row.accepted = false;
  assertExactModel(row.requestedModel, row.effectiveModel ? {
    provider: row.effectiveModel.split('/')[0], id: row.effectiveModel.slice(row.effectiveModel.indexOf('/') + 1),
  } : null);
  return validateBenchmarkRow(row);
}

export function summarizeRows(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'summary needs at least one JSONL row');
  for (const row of rows) {
    validateBenchmarkRow(row);
    assert.equal(row.kind, 'benchmark', 'summary accepts benchmark rows only');
  }
  const grouped = new Map();
  for (const thinking of THINKING_LEVELS) grouped.set(thinking, rows.filter(row => row.requestedThinking === thinking));
  const result = [];
  for (const [thinking, group] of grouped) {
    if (group.length === 0) continue;
    const knownAggregate = key => {
      const known = group.map(row => row[key]).filter(value => value !== null);
      return {
        knownTrials: known.length,
        unknownTrials: group.length - known.length,
        // This is explicitly the sum of known observations, never an imputed total.
        knownTotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
      };
    };
    result.push({
      thinking,
      trials: group.length,
      accepted: group.filter(row => row.accepted).length,
      acceptanceRate: group.filter(row => row.accepted).length / group.length,
      meanElapsedMs: group.reduce((sum, row) => sum + row.elapsedMs, 0) / group.length,
      tokens: knownAggregate('tokens'),
      costUsd: knownAggregate('costUsd'),
      turns: knownAggregate('turns'),
      providerRetries: knownAggregate('providerRetries'),
      correctiveAttempts: group.reduce((sum, row) => sum + row.correctiveAttempts, 0),
    });
  }
  return {
    schemaVersion: 1,
    kind: 'summary',
    byThinking: result,
    note: 'Offline descriptive metrics only; no quality or cost recommendation is inferred without live data.',
  };
}

export function parseJsonl(text) {
  assert.equal(typeof text, 'string');
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1)?.trim() === '') lines.pop();
  assert.ok(lines.length > 0, 'summary file is empty');
  return lines.map((line, index) => {
    assert.ok(line.trim(), `blank JSONL line at ${index + 1}`);
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed JSONL at line ${index + 1}: ${error.message}`);
    }
    return validateBenchmarkRow(row);
  });
}

export function runAcceptance(task, workspace, timeoutMs = ACCEPTANCE_TIMEOUT_MS) {
  assert.ok(Object.hasOwn(TASKS, task), `Unknown acceptance task: ${task}`);
  const env = { ...process.env, PI_BENCH_TASK: task, PI_BENCH_WORKSPACE: workspace };
  // A node:test worker marker makes nested --test subprocesses suppress output.
  // Acceptance is an independent test process, not another worker in this suite.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', VALIDATION_DRIVER], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
    env,
  });
  if (result.error) return { accepted: false, failure: result.error.message };
  if (result.status !== 0) {
    return { accepted: false, failure: (result.stderr || result.stdout || `acceptance exited ${result.status}`).trim().slice(0, 2_000) };
  }
  return { accepted: true, failure: null };
}

function resolvePiEntrypoint() {
  const explicit = process.env.PI_TEST_PI_PACKAGE;
  if (explicit) {
    const path = resolve(explicit);
    return statSync(path).isDirectory() ? join(path, 'dist/index.js') : path;
  }
  try {
    return createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent');
  } catch {
    const activeDir = activeAgentDir();
    const install = join(activeDir, 'install');
    const version = readFileSync(join(install, 'current-version'), 'utf8').trim();
    assert.match(version, /^[a-zA-Z0-9._-]+$/, 'Invalid managed Pi version');
    return join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  }
}

function activeAgentDir() {
  return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'));
}

function initialRow({ kind, role, task, model, thinking }) {
  return {
    schemaVersion: 1,
    kind,
    role,
    ...(kind === 'benchmark' ? { task } : { task: 'smoke' }),
    requestedModel: model || 'unresolved',
    effectiveModel: null,
    requestedThinking: thinking ?? null,
    effectiveThinking: null,
    elapsedMs: 0,
    tokens: null,
    costUsd: null,
    turns: null,
    providerRetries: null,
    correctiveAttempts: 0,
    failure: null,
    aborted: false,
    accepted: false,
  };
}

function readRolePin(role) {
  const rolePath = join(repoRoot, 'agent/agents', `${role}.md`);
  const content = readFileSync(rolePath, 'utf8');
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? '';
  return {
    content,
    model: frontmatter.match(/^model:\s*(.+?)\s*$/mu)?.[1],
    thinking: frontmatter.match(/^thinking:\s*(.+?)\s*$/mu)?.[1],
  };
}

function setFrontmatter(content, values) {
  const match = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/u);
  assert.ok(match, 'role fixture must have YAML frontmatter');
  let lines = match[2].split('\n');
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex(line => new RegExp(`^${key}:`).test(line));
    const line = `${key}: ${value}`;
    if (index < 0) lines.push(line);
    else lines[index] = line;
  }
  return `${match[1]}${lines.join('\n')}${match[3]}${content.slice(match[0].length)}`;
}

function createTrialFixture({ role, task, thinking }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-mechanic-benchmark-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(join(workspace, '.pi/agents'), { recursive: true });
  mkdirSync(join(agentDir, 'agents'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  const pin = readRolePin(role);
  const roleContent = setFrontmatter(pin.content, {
    ...(thinking ? { thinking } : {}),
    extensions: 'false',
    skills: 'false',
    persist_session: 'false',
  });
  writeFileSync(join(workspace, `.pi/agents/${role}.md`), roleContent);
  if (task) writeFileSync(join(workspace, 'src', task === 'discount-fix' ? 'discount.mjs' : 'score.mjs'), TASKS[task].initial);

  // Read only the active credentials explicitly, then allow SDK OAuth refreshes only on this private copy.
  const activeAuth = join(activeAgentDir(), 'auth.json');
  const fixtureAuth = join(agentDir, 'auth.json');
  if (existsSync(activeAuth)) copyFileSync(activeAuth, fixtureAuth);
  const modelPath = join(activeAgentDir(), 'models.json');
  return { root, workspace, agentDir, authPath: fixtureAuth, modelsPath: modelPath, role, task, thinking, requestedModel: pin.model, requestedThinking: thinking ?? pin.thinking };
}

export async function loadRunner(fixture, signal) {
  const sdkEntry = resolvePiEntrypoint();
  const realSdk = await import(pathToFileURL(sdkEntry).href);
  const sdkRequire = createRequire(sdkEntry);
  const typeboxEntry = sdkRequire.resolve('typebox');
  const typeboxRequire = createRequire(typeboxEntry);
  const [typebox, typeboxCompile, typeboxValue] = await Promise.all([
    import(pathToFileURL(typeboxEntry).href),
    import(pathToFileURL(typeboxRequire.resolve('typebox/compile')).href),
    import(pathToFileURL(typeboxRequire.resolve('typebox/value')).href),
  ]);
  const runtimeSource = join(fixture.root, 'runtime-source');
  cpSync(join(extensionRoot, 'src'), runtimeSource, { recursive: true });
  symlinkSync(join(repoRoot, 'agent/npm/node_modules'), join(fixture.root, 'node_modules'), 'dir');

  class IsolatedSettingsManager extends realSdk.SettingsManager {
    static create(_cwd, _agentDir, options = {}) {
      return realSdk.SettingsManager.inMemory({}, { projectTrusted: options.projectTrusted ?? false });
    }
  }
  class FixtureResourceLoader extends realSdk.DefaultResourceLoader {
    constructor(options) {
      super({
        ...options,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
    }
  }
  const virtualSdk = {
    ...realSdk,
    getAgentDir: () => fixture.agentDir,
    SettingsManager: IsolatedSettingsManager,
    DefaultResourceLoader: FixtureResourceLoader,
  };
  const { createJiti } = localRequire('jiti');
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    tryNative: false,
    virtualModules: {
      '@earendil-works/pi-coding-agent': virtualSdk,
      typebox,
      'typebox/compile': typeboxCompile,
      'typebox/value': typeboxValue,
    },
  });
  // A single facade import shares the same agent registry across all source modules.
  const facade = join(runtimeSource, 'benchmark-entry.ts');
  writeFileSync(facade, [
    "export * as agentsModule from './custom-agents.js';",
    "export * as typesModule from './agent-types.js';",
    "export * as invocationModule from './invocation-config.js';",
    "export * as modelModule from './model-resolver.js';",
    "export * as runnerModule from './agent-runner.js';",
  ].join('\n'));
  const modules = await jiti.import(facade);
  modules.runnerModule.setRememberAgents(false);
  modules.runnerModule.setGraceTurns(5);

  const modelRuntime = await realSdk.ModelRuntime.create({
    authPath: fixture.authPath,
    modelsPath: fixture.modelsPath,
    modelsStorePath: join(fixture.agentDir, 'models-store.json'),
    allowModelNetwork: false,
    signal,
  });
  const registry = new realSdk.ModelRegistry(modelRuntime);
  return { realSdk, modules, modelRuntime, registry };
}

async function runWorkerAttempt(payload) {
  const fixture = payload.fixture;
  const row = initialRow({
    kind: payload.kind,
    role: fixture.role,
    task: fixture.task,
    model: fixture.requestedModel,
    thinking: fixture.requestedThinking,
  });
  let session;
  try {
    const controller = new AbortController();
    const setup = await loadRunner(fixture, controller.signal);
    const loaded = setup.modules.agentsModule.loadCustomAgents(fixture.workspace, false, {
      packageDirs: [], packageFiles: [], packageExcluded: () => false,
    });
    setup.modules.typesModule.registerAgents(loaded);
    const config = setup.modules.typesModule.getAgentConfig(fixture.role);
    if (!config) throw new Error(`Role ${fixture.role} was not discovered in the isolated fixture`);
    row.requestedModel = config.model ?? row.requestedModel;
    row.requestedThinking = config.thinking ?? row.requestedThinking;
    const invocation = setup.modules.invocationModule.resolveAgentInvocationConfig(config, { max_turns: 24 }, { defaultRunInBackground: false });
    if (!invocation.modelInput) throw new Error(`Role ${fixture.role} has no pinned model`);
    const available = setup.registry.getAvailable().some(model => `${model.provider}/${model.id}`.toLowerCase() === invocation.modelInput.toLowerCase());
    if (!available) throw new Error(`Pinned model ${invocation.modelInput} is not auth-available; provider fallback is disabled`);
    const model = setup.modules.modelModule.resolveModel(invocation.modelInput, setup.registry);
    if (typeof model === 'string') throw new Error(model);
    assertExactModel(invocation.modelInput, model);
    const runPrompt = payload.kind === 'smoke'
      ? `Reply with exactly this marker and no punctuation: ${SMOKE_MARKER}`
      : TASKS[fixture.task].prompt;
    const result = await collectAgentAttempt({
      row,
      model,
      thinking: invocation.thinking,
      timeoutMs: payload.timeoutMs,
      invoke: callbacks => setup.modules.runnerModule.runAgent({
        cwd: fixture.workspace,
        model,
        modelRegistry: setup.registry,
        getSystemPrompt: () => undefined,
        isProjectTrusted: () => false,
        sessionManager: { getSessionFile: () => undefined },
      }, fixture.role, runPrompt, {
        pi: { exec: async () => ({ code: 1, stdout: '', stderr: '' }) },
        model,
        maxTurns: invocation.maxTurns,
        thinkingLevel: invocation.thinking,
        isolated: invocation.isolated,
        cwd: fixture.workspace,
        configCwd: fixture.workspace,
        signal: callbacks.signal,
        onSessionCreated: sessionValue => {
          session = sessionValue;
          callbacks.onSessionCreated(sessionValue);
        },
        onTurnEnd: callbacks.onTurnEnd,
        onAssistantUsage: callbacks.onAssistantUsage,
      }),
    });
    if (!row.failure && !row.aborted) {
      if (payload.kind === 'smoke') {
        row.accepted = row.responseText.trim() === SMOKE_MARKER;
        if (!row.accepted) row.failure = `Smoke marker mismatch: expected ${SMOKE_MARKER}`;
      } else {
        row.accepted = false; // parent runs the external acceptance driver after the child exits
      }
    }
    delete row.responseText;
  } catch (error) {
    row.failure = error instanceof Error ? error.message : String(error);
    row.accepted = false;
  }
  // The actual run result text is retained only in-process for smoke verification.
  // Benchmark trial acceptance is performed by the parent in a separate process.
  return validateBenchmarkRow(row);
}

function runWorker(payload) {
  runWorkerAttempt(payload).then(row => {
    process.stdout.write(`${JSON.stringify(row)}\n`, () => process.exit(0));
  }).catch(error => {
    const fallback = initialRow({
      kind: payload.kind,
      role: payload.fixture.role,
      task: payload.fixture.task,
      model: payload.fixture.requestedModel,
      thinking: payload.fixture.requestedThinking,
    });
    fallback.failure = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(fallback)}\n`, () => process.exit(0));
  });
}

export function runIsolatedAttempt(payload, timeoutMs, { spawnWorker = spawn, hardKillGraceMs = HARD_KILL_GRACE_MS } = {}) {
  return new Promise(resolveAttempt => {
    const started = performance.now();
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const child = spawnWorker(process.execPath, [scriptPath, '--worker', Buffer.from(JSON.stringify(payload)).toString('base64url')], {
      cwd: payload.fixture.workspace,
      env: { ...process.env, PI_MECHANIC_BENCHMARK_WORKER_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    const finish = row => {
      if (settled) return;
      row.elapsedMs = Math.max(0, Math.round(performance.now() - started));
      // Validate BEFORE settling; malformed worker JSON must reach the fallback,
      // not clear the deadline and leave this promise unresolved forever.
      const validated = validateBenchmarkRow(row);
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolveAttempt(validated);
    };
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      const row = initialRow({ kind: payload.kind, role: payload.fixture.role, task: payload.fixture.task, model: payload.fixture.requestedModel, thinking: payload.fixture.requestedThinking });
      row.failure = error.message;
      row.elapsedMs = Math.round(performance.now() - started);
      finish(row);
    });
    child.on('close', () => {
      if (timedOut) {
        const row = initialRow({ kind: payload.kind, role: payload.fixture.role, task: payload.fixture.task, model: payload.fixture.requestedModel, thinking: payload.fixture.requestedThinking });
        row.failure = `Wall timeout after ${timeoutMs}ms; worker was terminated`;
        row.aborted = true;
        row.elapsedMs = Math.round(performance.now() - started);
        finish(row);
        return;
      }
      const line = stdout.trim().split(/\r?\n/u).at(-1);
      try {
        if (!line) throw new Error(stderr.trim() || 'Benchmark worker returned no result');
        finish(JSON.parse(line));
      } catch (error) {
        const row = initialRow({ kind: payload.kind, role: payload.fixture.role, task: payload.fixture.task, model: payload.fixture.requestedModel, thinking: payload.fixture.requestedThinking });
        row.failure = `Benchmark worker failed: ${error instanceof Error ? error.message : String(error)}`;
        row.elapsedMs = Math.round(performance.now() - started);
        finish(row);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    }, timeoutMs + hardKillGraceMs);
  });
}

function outputSink(path) {
  if (!path) return row => process.stdout.write(`${JSON.stringify(row)}\n`);
  const absolute = resolve(path);
  const fd = openSync(absolute, 'wx', 0o600);
  closeSync(fd);
  return row => writeFileSync(absolute, `${JSON.stringify(row)}\n`, { flag: 'a', mode: 0o600 });
}

function parseOptions(args, allowed) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') { values.live = true; continue; }
    if (arg === '--role' || arg === '--timeout-ms' || arg === '--output') {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
      if (!allowed.has(key)) throw new Error(`${arg} is not valid for this command`);
      if (values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires one value and may appear once`);
      values[key] = args[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (values.timeoutMs !== undefined) {
    values.timeoutMs = Number(values.timeoutMs);
    if (!Number.isSafeInteger(values.timeoutMs) || values.timeoutMs < 100 || values.timeoutMs > 3_600_000) {
      throw new Error('--timeout-ms must be an integer from 100 to 3600000');
    }
  } else values.timeoutMs = DEFAULT_TIMEOUT_MS;
  return values;
}

function usage() {
  return `Usage:\n  node scripts/benchmark-mechanic.mjs [--help]\n  node scripts/benchmark-mechanic.mjs smoke --live [--role mechanic] [--timeout-ms MS] [--output FILE]\n  node scripts/benchmark-mechanic.mjs run --live [--timeout-ms MS] [--output FILE]\n  node scripts/benchmark-mechanic.mjs summary <results.jsonl>\n\nSmoke and benchmark commands require --live; no provider calls are made otherwise.\nThe two benchmark tasks are run once each at high and max thinking (mechanic role only).\n`;
}

async function cli(argv) {
  const [command, ...args] = argv;
  if (!command) { process.stdout.write(usage()); return 0; }
  if (command === '--help' || command === '-h' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return 0;
  }
  if (command === 'summary') {
    if (args.length !== 1 || args[0].startsWith('--')) throw new Error('summary requires exactly one JSONL file path');
    const rows = parseJsonl(readFileSync(resolve(args[0]), 'utf8'));
    process.stdout.write(`${JSON.stringify(summarizeRows(rows), null, 2)}\n`);
    return 0;
  }
  if (!['smoke', 'run'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options = parseOptions(args, command === 'smoke' ? new Set(['live', 'role', 'timeoutMs', 'output']) : new Set(['live', 'timeoutMs', 'output']));
  if (!options.live) throw new Error(`Refusing to run ${command} without explicit --live consent`);
  const role = command === 'smoke' ? options.role ?? 'mechanic' : 'mechanic';
  if (!/^[a-zA-Z0-9_-]+$/u.test(role)) throw new Error('--role must be a simple role name');
  const rolePath = join(repoRoot, 'agent/agents', `${role}.md`);
  if (!existsSync(rolePath)) throw new Error(`Unknown role: ${role}`);
  const sink = outputSink(options.output);
  const trials = command === 'smoke'
    ? [{ kind: 'smoke', role, task: null, thinking: null }]
    : THINKING_LEVELS.flatMap(thinking => Object.keys(TASKS).map(task => ({ kind: 'benchmark', role: 'mechanic', task, thinking })));
  let failed = false;
  for (const trial of trials) {
    const fixture = createTrialFixture(trial);
    try {
      const payload = { kind: trial.kind, fixture, timeoutMs: options.timeoutMs };
      const row = await runIsolatedAttempt(payload, options.timeoutMs);
      if (trial.kind === 'benchmark' && !row.failure && !row.aborted) {
        const accepted = runAcceptance(trial.task, fixture.workspace);
        row.accepted = accepted.accepted;
        if (!accepted.accepted) row.failure = `Acceptance failed: ${accepted.failure}`;
      }
      validateBenchmarkRow(row);
      sink(row);
      if (!row.accepted) failed = true;
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  if (options.output) process.stderr.write(`Results written to ${resolve(options.output)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[2] === '--worker') {
  if (!process.env.PI_MECHANIC_BENCHMARK_WORKER_TOKEN) {
    process.stderr.write('Worker mode is internal.\n');
    process.exit(2);
  }
  try {
    runWorker(JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64url').toString('utf8')));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
} else if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
