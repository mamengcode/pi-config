#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agentRequire = createRequire(join(agentDir, "npm", "package.json"));
let pkgDir;

try {
  pkgDir = dirname(agentRequire.resolve("pi-open-agents/package.json"));
} catch {
  console.error(`Unable to find pi-open-agents under ${join(agentDir, "npm")}`);
  process.exit(1);
}

// 1. Patch selector.ts to use Alt+A
const selectorPath = join(pkgDir, "src", "tui", "selector.ts");
if (existsSync(selectorPath)) {
  let content = readFileSync(selectorPath, "utf8");
  if (content.includes('Key.ctrlShift("m")')) {
    content = content.replace('Key.ctrlShift("m")', 'Key.alt("a")');
    writeFileSync(selectorPath, content, "utf8");
    console.log("==> Patched selector.ts to use Alt+A");
  }
}

// 2. Patch manager.ts to support custom & workflow agent ordering
const managerPath = join(pkgDir, "src", "primary", "manager.ts");
if (existsSync(managerPath)) {
  let content = readFileSync(managerPath, "utf8");
  if (!content.includes("customOrder")) {
    content = content.replace(
      /setAgents\(agents: AgentDefinition\[\]\): void \{\s*this\.agents = new Map\(agents\.map\(\(a\) => \[a\.name, a\]\)\);\s*\}/,
      `setAgents(agents: AgentDefinition[], customOrder?: string[]): void {
    const order = customOrder ?? ["explorer", "planner", "coordinator", "direct-implementer"];
    const sorted = [...agents].sort((a, b) => {
      const idxA = order.indexOf(a.name);
      const idxB = order.indexOf(b.name);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
    this.agents = new Map(sorted.map((a) => [a.name, a]));
  }`
    );
    content = content.replace(
      /\.map\(\(a\) => a\.name\)\s*\.sort\(\);/,
      `.map((a) => a.name);`
    );
    writeFileSync(managerPath, content, "utf8");
    console.log("==> Patched manager.ts for workflow agent ordering");
  }
}

// 3. Patch index.ts to pass settings.agentOrder
const indexPath = join(pkgDir, "src", "index.ts");
if (existsSync(indexPath)) {
  let content = readFileSync(indexPath, "utf8");
  if (!content.includes("agentOrder?: string[];")) {
    content = content.replace(
      /interface Settings \{/,
      `interface Settings {\n  agentOrder?: string[];`
    );
    content = content.replace(
      /manager\.setAgents\(result\.agents\);/,
      `manager.setAgents(result.agents, settings.agentOrder);`
    );
    writeFileSync(indexPath, content, "utf8");
    console.log("==> Patched index.ts to pass agentOrder");
  }
}
