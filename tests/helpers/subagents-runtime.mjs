import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const extensionRoot = join(repo, 'agent/npm/node_modules/@tintinweb/pi-subagents');
const localRequire = createRequire(join(repo, 'agent/npm/package.json'));

export function resolvePiEntrypoint() {
  const explicit = process.env.PI_TEST_PI_PACKAGE;
  if (explicit) {
    const path = resolve(explicit);
    return (awaitStat(path).isDirectory()) ? join(path, 'dist/index.js') : path;
  }
  try {
    return createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent');
  } catch {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    const install = join(agentDir, 'install');
    const version = readFileSync(join(install, 'current-version'), 'utf8').trim();
    assert.match(version, /^[a-zA-Z0-9._-]+$/, 'Invalid managed Pi version');
    return join(install, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist/index.js');
  }
}

function awaitStat(path) {
  // Kept synchronous to match startup.test.mjs's explicit package override behavior.
  return localRequire('node:fs').statSync(path);
}

export function makeFixture(t, { roles = [], extensions = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(join(agentDir, 'agents'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true });
  for (const role of roles) {
    cpSync(join(repo, 'agent', 'agents', `${role}.md`), join(cwd, '.pi', 'agents', `${role}.md`));
  }
  return { root, agentDir, cwd, extensions, harnessDir: join(root, 'harness') };
}

export async function createSubagentsHarness(t, options = {}) {
  const fixture = makeFixture(t, options);
  let activeAgentDir = fixture.agentDir;
  const sdkEntry = resolvePiEntrypoint();
  const sdkRequire = createRequire(sdkEntry);
  const sdkUrl = pathToFileURL(sdkEntry).href;
  const realSdk = await import(sdkUrl);
  const typeboxPath = sdkRequire.resolve('typebox');
  const typeboxRequire = createRequire(typeboxPath);
  const [typebox, typeboxCompile, typeboxValue] = await Promise.all([
    import(pathToFileURL(typeboxPath).href),
    import(pathToFileURL(typeboxRequire.resolve('typebox/compile')).href),
    import(pathToFileURL(typeboxRequire.resolve('typebox/value')).href),
  ]);
  const runtimeSource = join(fixture.root, 'runtime-source');
  cpSync(join(extensionRoot, 'src'), runtimeSource, { recursive: true });
  symlinkSync(join(repo, 'agent/npm/node_modules'), join(fixture.root, 'node_modules'), 'dir');
  const { createJiti } = localRequire('jiti');
  const scripts = [...(options.scripts ?? [])];
  const captures = { loaders: [], sessions: [], sessionOptions: [] };

  class IsolatedSettingsManager extends realSdk.SettingsManager {
    static create(_cwd, _agentDir, createOptions = {}) {
      const manager = realSdk.SettingsManager.inMemory({}, { projectTrusted: createOptions.projectTrusted ?? false });
      return manager;
    }
  }

  class CapturingResourceLoader {
    constructor(loaderOptions) {
      this.options = loaderOptions;
      this.extensions = fixture.extensions;
      this.toolCallHandlers = [];
      captures.loaders.push(this);
    }
    async reload() {
      // Execute the real scope-gate factory, not unrelated MCP/CLI factories.
      if (!this.options.noExtensions) {
        for (const inline of this.options.extensionFactories ?? []) {
          if (inline.name === 'pi-subagents-scope') {
            await inline.factory({ on: (event, handler) => {
              if (event === 'tool_call') this.toolCallHandlers.push(handler);
            } });
          }
        }
      }
      if (this.options.noExtensions) {
        this.extensions = [];
      } else if (this.options.extensionsOverride) {
        this.extensions = this.options.extensionsOverride({ extensions: fixture.extensions }).extensions;
      }
    }
    getExtensions() { return { extensions: this.extensions }; }
  }

  const virtualSdk = {
    ...realSdk,
    getAgentDir: () => activeAgentDir,
    SettingsManager: IsolatedSettingsManager,
    DefaultResourceLoader: CapturingResourceLoader,
    async createAgentSession(sessionOptions) {
      captures.sessionOptions.push(sessionOptions);
      const script = scripts.shift() ?? { text: 'scripted result' };
      const session = createScriptedSession(sessionOptions, script, captures);
      captures.sessions.push(session);
      return { session, extensionsResult: { extensions: fixture.extensions } };
    },
  };
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    tryNative: false,
    virtualModules: {
      '@earendil-works/pi-coding-agent': virtualSdk,
      'typebox': typebox,
      'typebox/compile': typeboxCompile,
      'typebox/value': typeboxValue,
    },
  });
  // Use one module graph and the same .js specifiers as the extension itself.
  // Separate asynchronous entry imports can instantiate competing registries.
  const entry = join(runtimeSource, 'test-entry.ts');
  writeFileSync(entry, [
    "export * as agentsModule from './custom-agents.js';",
    "export * as typesModule from './agent-types.js';",
    "export * as invocationModule from './invocation-config.js';",
    "export * as modelModule from './model-resolver.js';",
    "export * as runnerModule from './agent-runner.js';",
  ].join('\n'));
  const { agentsModule, typesModule, invocationModule, modelModule, runnerModule } = await jiti.import(entry);
  runnerModule.setRememberAgents(false);
  runnerModule.setGraceTurns(5);

  const models = [
    { provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { provider: 'alternate', id: 'conflict-model', name: 'Conflict Model' },
  ];
  const modelRegistry = {
    getAvailable: () => models,
    getAll: () => models,
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
  };
  const ctx = {
    cwd: fixture.cwd,
    model: models[0],
    modelRegistry,
    getSystemPrompt: () => 'PARENT_SYSTEM_PROMPT_MUST_NOT_LEAK',
    isProjectTrusted: () => false,
    sessionManager: { getSessionFile: () => undefined },
  };
  const pi = {
    exec: async (command, args) => ({
      code: command === 'git' && args?.[0] === 'rev-parse' ? 1 : 0,
      stdout: '',
      stderr: '',
    }),
  };

  async function loadAndRegister(optionsForLoader = {}) {
    activeAgentDir = fixture.agentDir;
    const loaded = agentsModule.loadCustomAgents(fixture.cwd, false, {
      packageDirs: [],
      packageFiles: [],
      packageExcluded: () => false,
      ...optionsForLoader,
    });
    typesModule.registerAgents(loaded);
    return loaded;
  }

  async function invoke(type, prompt, params = {}, runOptions = {}) {
    const loaded = await loadAndRegister();
    const config = typesModule.getAgentConfig(type);
    assert.ok(config, `Expected fixture role ${type} to be discovered`);
    const invocation = invocationModule.resolveAgentInvocationConfig(config, params, {
      defaultRunInBackground: false,
    });
    let model = ctx.model;
    if (invocation.modelInput) {
      const resolved = modelModule.resolveModel(invocation.modelInput, modelRegistry);
      assert.notEqual(typeof resolved, 'string', `Could not resolve ${invocation.modelInput}: ${resolved}`);
      model = resolved;
    }
    const result = await runnerModule.runAgent(ctx, type, prompt, {
      pi,
      model,
      maxTurns: invocation.maxTurns,
      thinkingLevel: invocation.thinking,
      inheritContext: invocation.inheritContext,
      isolated: invocation.isolated,
      ...runOptions,
    });
    return { result, config, invocation, loaded, model, session: result.session };
  }

  return {
    fixture,
    sdk: realSdk,
    modules: { agentsModule, typesModule, invocationModule, modelModule, runnerModule },
    captures,
    models,
    modelRegistry,
    ctx,
    pi,
    loadAndRegister,
    invoke,
  };
}

function createScriptedSession(options, script, captures) {
  const listeners = new Set();
  const baseTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const session = {
    messages: [],
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    agent: { state: { tools: [] } },
    activeTools: (options.tools ?? ['read', 'bash', 'edit', 'write'])
      .filter(name => !options.excludeTools?.includes(name)),
    steers: [],
    turnSnapshots: [],
    abortCalls: 0,
    disposed: false,
    setSessionName(name) { this.sessionName = name; },
    async bindExtensions() {
      script.afterBind?.({ session: this, loader: captures.loaders.at(-1), options });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    async prompt(prompt) {
      this.promptText = prompt;
      if (script.reject) throw script.reject instanceof Error ? script.reject : new Error(String(script.reject));
      await script.onPrompt?.({ session: this, prompt, options });
      for (const event of script.events ?? []) this.emit(event);
      const text = script.text ?? '';
      const content = text ? [{ type: 'text', text }] : [];
      const message = {
        role: 'assistant',
        content,
        stopReason: script.stopReason ?? 'stop',
        ...(script.errorMessage ? { errorMessage: script.errorMessage } : {}),
        ...(script.usage ? { usage: script.usage } : {}),
      };
      this.messages.push(message);
      this.emit({ type: 'message_start', message });
      if (text) this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
      this.emit({ type: 'message_end', message });
      const turns = script.turns ?? 1;
      for (let index = 0; index < turns; index++) {
        this.emit({ type: 'turn_end' });
        this.turnSnapshots.push({ turn: index + 1, steers: this.steers.length, abortCalls: this.abortCalls });
      }
    },
    async steer(message) { this.steers.push(message); },
    async abort() { this.abortCalls++; },
    async dispose() { this.disposed = true; },
    getActiveToolNames() { return [...this.activeTools]; },
    getAllTools() {
      const loaded = captures.loaders.at(-1)?.getExtensions().extensions ?? [];
      const extensionTools = loaded.flatMap(extension => [...extension.tools.keys()]);
      const customNames = (options.customTools ?? []).map(tool => tool.name);
      const all = [...new Set([...baseTools, ...extensionTools, ...customNames])];
      return all.filter(name => (!options.tools || options.tools.includes(name))
        && !options.excludeTools?.includes(name))
        .map(name => ({ name, exposure: 'direct' }));
    },
    getToolDefinition() { return { defaultActive: true }; },
    setActiveToolsByName(names) { this.activeTools = [...names]; },
  };
  return session;
}

export function writeAgentFile(path, name, frontmatter, body = 'Fixture agent instructions.') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\n${frontmatter}---\n\n${body}\n`);
}
