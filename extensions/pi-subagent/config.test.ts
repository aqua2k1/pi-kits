import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatAvailableAgents,
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgentDefinition,
  resolveWorkerExtensions,
} from "./config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  return {
    cwd,
    agentDir,
    file(scope: "global" | "project", name: string, body: string) {
      const target =
        scope === "global"
          ? join(agentDir, "agents")
          : join(cwd, ".pi", "agent", "agents");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, name), body);
    },
  };
}

test("agent discovery has no built-ins and project agents override global agents case-insensitively", (t) => {
  const f = fixture(t);
  assert.equal(loadAgentDefinitions(f.cwd, f.agentDir).size, 0);
  assert.throws(
    () => resolveAgentDefinition(f.cwd, "Explore", f.agentDir),
    /Unknown subagent type/,
  );

  f.file(
    "global",
    "Reviewer.md",
    "---\nmodel: global-model\nthinking: high\ntools: read\nprompt_mode: append\n---\nGlobal prompt",
  );
  f.file("global", "other.md", "Other prompt");
  f.file(
    "project",
    "reviewer.md",
    "---\ndescription: Project reviewer\n---\nProject prompt",
  );

  const agents = loadAgentDefinitions(f.cwd, f.agentDir);
  assert.equal(agents.size, 2);
  const reviewer = resolveAgentDefinition(f.cwd, "REVIEWER", f.agentDir);
  assert.equal(reviewer.source, "project");
  assert.equal(reviewer.systemPrompt, "Project prompt");
  assert.equal(reviewer.model, undefined);
  assert.equal(reviewer.tools, undefined);
  assert.equal(
    formatAvailableAgents(f.cwd, f.agentDir),
    " Configured agents: other (other), reviewer (Project reviewer).",
  );
});

test("flattened frontmatter parses tools, disallowed_tools, prompt_mode, inherit_context, and extensions", () => {
  const agent = parseAgentDefinition(
    `---
description: Security reviewer
display_name: Auditor
model: provider/model
thinking: high
tools: [read, bash, read]
disallowed_tools: edit, write
prompt_mode: append
inherit_context: true
extensions:
  - builtin:codemode
  - source: /pkg/root
    extensions: [pi-web-kits]
enabled: false
run_in_background: false
---

Review carefully.
`,
    "/agents/auditor.md",
    "global",
  );
  assert.equal(agent.name, "auditor");
  assert.equal(agent.description, "Security reviewer");
  assert.equal(agent.displayName, "Auditor");
  assert.equal(agent.model, "provider/model");
  assert.equal(agent.thinking, "high");
  assert.deepEqual(agent.tools, ["read", "bash"]);
  assert.deepEqual(agent.disallowedTools, ["edit", "write"]);
  assert.equal(agent.promptMode, "append");
  assert.equal(agent.inheritContext, true);
  assert.deepEqual(agent.extensions, [
    "builtin:codemode",
    { source: "/pkg/root", extensions: ["pi-web-kits"] },
  ]);
  assert.equal(agent.enabled, false);
  assert.equal(agent.runInBackground, false);
  assert.equal(agent.systemPrompt, "Review carefully.");

  const noTools = parseAgentDefinition(
    "---\ntools: none\nprompt_mode: append\n---\n",
    "/agents/empty.md",
    "global",
  );
  assert.deepEqual(noTools.tools, []);
  assert.equal(noTools.promptMode, "append");
});

test("invalid frontmatter values and empty replace body fail closed", () => {
  assert.throws(
    () => parseAgentDefinition("---\n---\n   ", "/agents/empty.md", "global"),
    /replace prompt_mode requires a non-empty agent body/,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        "---\nprompt_mode: invalid\n---\nBody",
        "/agents/bad.md",
        "global",
      ),
    /prompt_mode must be replace or append/,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        "---\ninherit_context: yes\n---\nBody",
        "/agents/bad.md",
        "global",
      ),
    /inherit_context must be a boolean/,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        '---\ntools: ["a,b"]\n---\nBody',
        "/agents/bad.md",
        "global",
      ),
    /invalid tool name/,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        '---\nextensions: [""]\n---\nBody',
        "/agents/bad.md",
        "global",
      ),
    /extensions must be a valid extension source list/,
  );
});

test("resolveWorkerExtensions resolves package extensionResources", async () => {
  assert.deepEqual(await resolveWorkerExtensions([]), []);
  assert.deepEqual(
    await resolveWorkerExtensions([
      { source: root, extensions: ["pi-open", "pi-ask"] },
    ]),
    [
      join(root, "extensions/pi-open/index.ts"),
      join(root, "extensions/pi-ask/index.ts"),
    ],
  );
});
