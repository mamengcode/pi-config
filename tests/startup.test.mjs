import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, existsSync, statSync, lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managedGuidance = join(repo, 'agent', 'AGENTS.md');

// Test the real installed Pi loader, not a reimplementation of its precedence.
// Non-managed installs can supply a package directory or entrypoint explicitly.
function piEntrypoint() {
  const explicit = process.env.PI_TEST_PI_PACKAGE;
  if (explicit) {
    const path = resolve(explicit);
    return statSync(path).isDirectory() ? join(path, 'dist', 'index.js') : path;
  }
  try {
    return createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent');
  } catch {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    const install = join(agentDir, 'install');
    const version = readFileSync(join(install, 'current-version'), 'utf8').trim();
    assert.match(version, /^[a-zA-Z0-9._-]+$/, 'Invalid managed Pi version');
    return join(install, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-startup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  const bin = join(root, 'bin');
  for (const path of [agentDir, cwd, bin]) mkdirSync(path);
  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" > "$PI_CODING_AGENT_DIR/npm-invocation"\n');
  chmodSync(npm, 0o755);
  const install = () => spawnSync('bash', [join(repo, 'install.sh')], {
    cwd: repo,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return { agentDir, cwd, install };
}

function assertInstalled(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function load(f) {
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(piEntrypoint()).href);
  const settingsManager = SettingsManager.inMemory({ packages: [] });
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  return loader;
}

function assertGlobalGuidance(loader, agentDir) {
  const files = loader.getAgentsFiles().agentsFiles;
  const global = files.find(file => file.path === join(agentDir, 'AGENTS.md'));
  assert.ok(global, 'Global orchestrator guidance must be included');
  assert.equal(global.content, readFileSync(managedGuidance, 'utf8'));
  assert.match(global.content, /Default agent: orchestrator/);
  assert.match(global.content, /agents\/orchestrator\.md/);
  assert.ok(existsSync(join(agentDir, 'agents', 'orchestrator.md')));
}

test('installer is repeatable and migrates only its own legacy append symlink', t => {
  const f = fixture(t);
  const managedAgents = join(repo, 'agent', 'agents');
  const managedAgentsLink = join(f.agentDir, 'agents');
  symlinkSync(join(repo, 'agent', 'APPEND_SYSTEM.md'), join(f.agentDir, 'APPEND_SYSTEM.md'));
  assertInstalled(f.install());
  assert.equal(readlinkSync(managedAgentsLink), managedAgents);
  const firstLinkStat = lstatSync(managedAgentsLink);
  assertInstalled(f.install());
  assert.equal(readlinkSync(managedAgentsLink), managedAgents);
  const secondLinkStat = lstatSync(managedAgentsLink);
  assert.equal(secondLinkStat.dev, firstLinkStat.dev);
  assert.equal(secondLinkStat.ino, firstLinkStat.ino, 'managed link should be left in place');
  assert.equal(realpathSync(join(f.agentDir, 'AGENTS.md')), managedGuidance);
  assert.ok(!existsSync(join(f.agentDir, 'APPEND_SYSTEM.md')));
  assert.equal(readFileSync(join(f.agentDir, 'npm-invocation'), 'utf8').trim(), 'install --omit=dev');
});

test('global orchestrator guidance loads with the default system prompt', async t => {
  const f = fixture(t);
  assertInstalled(f.install());
  const loader = await load(f);
  assertGlobalGuidance(loader, f.agentDir);
  assert.equal(loader.getSystemPrompt(), undefined);
});

test('project append prompt and project context override retain global orchestrator guidance', async t => {
  const f = fixture(t);
  assertInstalled(f.install());
  mkdirSync(join(f.cwd, '.pi'));
  writeFileSync(join(f.cwd, '.pi', 'APPEND_SYSTEM.md'), 'Project append instructions.');
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'Superseded project guidance.');
  writeFileSync(join(f.cwd, 'AGENTS.override.md'), 'Active project guidance.');
  const loader = await load(f);
  assertGlobalGuidance(loader, f.agentDir);
  assert.ok(loader.getAppendSystemPrompt().includes('Project append instructions.'));
  const files = loader.getAgentsFiles().agentsFiles;
  assert.ok(files.some(file => file.path === join(f.cwd, 'AGENTS.override.md')));
  assert.ok(!files.some(file => file.path === join(f.cwd, 'AGENTS.md')));
});

test('installer preserves user-owned append files and symlinks', t => {
  for (const kind of ['file', 'symlink']) {
    const f = fixture(t);
    const append = join(f.agentDir, 'APPEND_SYSTEM.md');
    const custom = join(f.cwd, 'custom-append.md');
    writeFileSync(custom, 'User-owned append instructions.');
    if (kind === 'symlink') symlinkSync(custom, append);
    else writeFileSync(append, 'User-owned append instructions.');
    assertInstalled(f.install());
    assert.equal(readFileSync(append, 'utf8'), 'User-owned append instructions.');
    if (kind === 'symlink') assert.equal(readlinkSync(append), custom);
  }
});

test('installer refuses unmanaged agent paths before changing settings or invoking npm', t => {
  const cases = [
    {
      name: 'directory',
      prepare(f, target) {
        mkdirSync(target);
        writeFileSync(join(target, 'custom.md'), 'Custom agent definition.');
      },
      assertPreserved(f, target) {
        assert.equal(readFileSync(join(target, 'custom.md'), 'utf8'), 'Custom agent definition.');
      },
    },
    {
      name: 'regular file',
      prepare(_f, target) {
        writeFileSync(target, 'User-owned agents file.');
      },
      assertPreserved(_f, target) {
        assert.equal(readFileSync(target, 'utf8'), 'User-owned agents file.');
      },
    },
    {
      name: 'foreign valid symlink',
      prepare(f, target) {
        const other = join(f.cwd, 'other-agents');
        mkdirSync(other);
        writeFileSync(join(other, 'custom.md'), 'Linked custom agent.');
        symlinkSync(other, target);
      },
      assertPreserved(f, target) {
        assert.equal(readlinkSync(target), join(f.cwd, 'other-agents'));
        assert.equal(readFileSync(join(target, 'custom.md'), 'utf8'), 'Linked custom agent.');
      },
    },
    {
      name: 'dangling symlink',
      prepare(f, target) {
        symlinkSync(join(f.cwd, 'missing-agents'), target);
      },
      assertPreserved(f, target) {
        assert.equal(existsSync(target), false);
        assert.equal(readlinkSync(target), join(f.cwd, 'missing-agents'));
      },
    },
  ];

  for (const scenario of cases) {
    const f = fixture(t);
    const target = join(f.agentDir, 'agents');
    scenario.prepare(f, target);
    const result = f.install();
    assert.notEqual(result.status, 0, scenario.name);
    assert.match(result.stderr, /Refusing to replace existing agent definitions/, scenario.name);
    assert.match(result.stderr, /Back it up or relocate it/, scenario.name);
    assert.equal(existsSync(join(f.agentDir, 'settings.json')), false, 'refusal must precede settings changes');
    assert.equal(existsSync(join(f.agentDir, 'npm-invocation')), false, 'refusal must precede npm');
    scenario.assertPreserved(f, target);
  }
});

test('installer refuses to overwrite or shadow pre-existing global guidance', t => {
  for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
    const f = fixture(t);
    const guidance = join(f.agentDir, name);
    writeFileSync(guidance, 'Existing user guidance.');
    const result = f.install();
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Refusing to replace or shadow/);
    assert.equal(readFileSync(guidance, 'utf8'), 'Existing user guidance.');
    assert.ok(!existsSync(join(f.agentDir, 'settings.json')), 'Conflict must fail before settings are changed');
  }
});
