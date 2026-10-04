import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgentDefinition,
} from "./agents.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-definitions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  return {
    cwd,
    agentDir,
    file(scope: "global" | "project", name: string, body: string) {
      const dir =
        scope === "global"
          ? join(agentDir, "agents")
          : join(cwd, ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
    },
  };
}

test("agent discovery has no built-in definitions and does not create directories", (t) => {
  const f = fixture(t);
  assert.equal(loadAgentDefinitions(f.cwd, f.agentDir).size, 0);
  assert.throws(
    () => resolveAgentDefinition(f.cwd, "Explore", f.agentDir),
    /Unknown subagent type/,
  );
});

test("project agents replace same-name global files as a whole, case-insensitively", (t) => {
  const f = fixture(t);
  f.file(
    "global",
    "Reviewer.md",
    "---\nmodel: global-model\ntools: read\nthinking: high\n---\nGlobal prompt",
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
  assert.equal(reviewer.thinking, undefined);
  assert.equal(agents.get("other")?.source, "global");
  f.file("project", "reviewer.md", "Updated prompt");
  assert.equal(
    resolveAgentDefinition(f.cwd, "reviewer", f.agentDir).systemPrompt,
    "Updated prompt",
  );
});

test("disabled project configuration shadows an enabled global type", (t) => {
  const f = fixture(t);
  f.file("global", "review.md", "Global prompt");
  f.file("project", "review.md", "---\nenabled: false\n---\nDisabled");
  assert.equal(
    loadAgentDefinitions(f.cwd, f.agentDir).get("review")?.enabled,
    false,
  );
  assert.throws(
    () => resolveAgentDefinition(f.cwd, "review", f.agentDir),
    /disabled/,
  );
});

test("Markdown frontmatter supports model, thinking, tool lists, prompt mode and UI names", () => {
  const agent = parseAgentDefinition(
    `---
description: Security reviewer
display_name: Auditor
model: provider/model
thinking: max
tools: [read, bash, read]
disallowed_tools: edit, write
prompt_mode: append
run_in_background: false
---
\nReview carefully.\n`,
    "/agents/auditor.md",
    "global",
  );
  assert.equal(agent.name, "auditor");
  assert.equal(agent.displayName, "Auditor");
  assert.equal(agent.model, "provider/model");
  assert.equal(agent.thinking, "max");
  assert.deepEqual(agent.tools, ["read", "bash"]);
  assert.deepEqual(agent.disallowedTools, ["edit", "write"]);
  assert.equal(agent.promptMode, "append");
  assert.equal(agent.systemPrompt, "Review carefully.");
  assert.equal(agent.runInBackground, false);
});

test("explicit empty/none tools never fall back to unrestricted tools", () => {
  for (const value of ["none", "[]", '""']) {
    const agent = parseAgentDefinition(
      `---\ntools: ${value}\n---\nPrompt`,
      "/agents/empty.md",
      "project",
    );
    assert.deepEqual(agent.tools, []);
  }
  assert.equal(
    parseAgentDefinition("Prompt", "/agents/plain.md", "global").tools,
    undefined,
  );
});

test("invalid and unsupported settings fail closed, never silently widen permissions", () => {
  for (const fields of [
    "tools: bogus",
    "tools: null",
    "tools: 123",
    "tools: [false]",
    "thinking: unlimited",
    "model: false",
    "enabled: yes",
    "run_in_background: nope",
    "prompt_mode: typo",
    "max_turns: 30",
    "extensions: true",
    "memory: project",
    "isolation: worktree",
  ]) {
    assert.throws(
      () =>
        parseAgentDefinition(
          `---\n${fields}\n---\nPrompt`,
          "/agents/bad.md",
          "project",
        ),
      /Invalid agent/,
    );
  }
  for (const invalid of [
    "---\ntools: [\n---\nPrompt",
    "---\ntools: none",
    "---\nfalse\n---\nPrompt",
    "---\n[read]\n---\nPrompt",
  ]) {
    assert.throws(
      () => parseAgentDefinition(invalid, "/agents/bad.md", "project"),
      /YAML/,
    );
  }
});

test("discovery ignores non-markdown files and directories; rejects duplicate names", (t) => {
  const f = fixture(t);
  f.file("project", "note.txt", "Ignored");
  f.file("project", "same.md", "Prompt");
  mkdirSync(join(f.cwd, ".pi", "agents", "directory.md"));
  assert.equal(loadAgentDefinitions(f.cwd, f.agentDir).size, 1);
  f.file("project", "SAME.md", "Duplicate");
  assert.throws(
    () => loadAgentDefinitions(f.cwd, f.agentDir),
    /Duplicate agent/,
  );
});

test("malformed project overrides are errors, not fallback to the global definition", (t) => {
  const f = fixture(t);
  f.file("global", "review.md", "Global prompt");
  f.file("project", "review.md", "---\ntools: 123\n---\nProject");
  assert.throws(() => loadAgentDefinitions(f.cwd, f.agentDir), /Invalid agent/);
  f.file("project", "review.md", "x".repeat(65 * 1024));
  assert.throws(() => loadAgentDefinitions(f.cwd, f.agentDir), /limit 64 KiB/);
});
