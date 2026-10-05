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
          : join(cwd, ".pi", "agent", "agents");
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

test("project discovery uses .pi/agent/agents and ignores .pi/agents", (t) => {
  const f = fixture(t);
  const legacyDir = join(f.cwd, ".pi", "agents");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "legacy.md"), "Legacy prompt");
  f.file("project", "review.md", "Project prompt");

  const agents = loadAgentDefinitions(f.cwd, f.agentDir);
  assert.equal(agents.size, 1);
  assert.equal(
    agents.get("review")?.sourcePath,
    join(f.cwd, ".pi", "agent", "agents", "review.md"),
  );
  assert.equal(agents.get("review")?.source, "project");
});

test("project agents replace same-name global files as a whole, case-insensitively", (t) => {
  const f = fixture(t);
  f.file(
    "global",
    "Reviewer.md",
    "---\nmodel: global-model\ntools: read\nthinking: high\nprompt_mode: append\n---\nGlobal prompt",
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
  assert.equal(reviewer.promptMode, undefined);
  assert.equal(agents.get("other")?.source, "global");
  f.file("project", "reviewer.md", "Updated prompt");
  assert.equal(
    resolveAgentDefinition(f.cwd, "reviewer", f.agentDir).systemPrompt,
    "Updated prompt",
  );
});

test("project replacements skip invalid or oversized global contents", (t) => {
  const f = fixture(t);
  f.file("global", "review.md", "---\ntools: 123\n---\nGlobal prompt");
  f.file("global", "large.md", "x".repeat(64 * 1024 + 1));
  f.file("project", "review.md", "---\ntools: none\n---\nProject prompt");
  f.file("project", "large.md", "Project prompt");
  const agents = loadAgentDefinitions(f.cwd, f.agentDir);
  assert.equal(agents.get("review")?.source, "project");
  assert.deepEqual(agents.get("review")?.tools, []);
  assert.equal(agents.get("large")?.systemPrompt, "Project prompt");
  f.file("project", "review.md", "---\ntools: 123\n---\nInvalid project");
  assert.throws(() => loadAgentDefinitions(f.cwd, f.agentDir), /Invalid agent/);
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

test("Markdown frontmatter supports model, thinking, tool lists, context inheritance and UI names", () => {
  const agent = parseAgentDefinition(
    `---
description: Security reviewer
display_name: Auditor
model: provider/model
thinking: max
tools: [read, bash, read]
disallowed_tools: edit, write
inherit_context: true
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
  assert.equal(agent.inheritContext, true);
  assert.equal(agent.systemPrompt, "Review carefully.");
  assert.equal(agent.runInBackground, false);
});

test("inherit_context is optional, strictly boolean and independent of prompt mode", () => {
  assert.equal(
    parseAgentDefinition("Role", "/agents/plain.md", "global").inheritContext,
    undefined,
  );
  for (const value of [true, false]) {
    const agent = parseAgentDefinition(
      `---\ninherit_context: ${value}\n---\nRole`,
      "/agents/test.md",
      "project",
    );
    assert.equal(agent.inheritContext, value);
  }
  for (const value of ["null", "yes", "1", "inherit"]) {
    assert.throws(
      () =>
        parseAgentDefinition(
          `---\ninherit_context: ${value}\n---\nRole`,
          "/agents/test.md",
          "project",
        ),
      /boolean/,
    );
  }
});

test("prompt_mode preserves omission while defaulting effectively to replace", () => {
  assert.equal(
    parseAgentDefinition("Role", "/agents/plain.md", "global").promptMode,
    undefined,
  );
  for (const runtime of ["", "runtime: pi\n", "runtime: codex\n"]) {
    const agent = parseAgentDefinition(
      `---\n${runtime}description: Test\n---\nRole`,
      "/agents/test.md",
      "project",
    );
    assert.equal(agent.promptMode, undefined);
    assert.equal(agent.promptMode ?? "replace", "replace");
    assert.equal(agent.systemPrompt, "Role");
  }
});

test("prompt_mode accepts replace and append for explicit or omitted Pi runtime", () => {
  for (const runtime of ["", "runtime: pi\n"]) {
    for (const mode of ["replace", "append"] as const) {
      const agent = parseAgentDefinition(
        `---\n${runtime}prompt_mode: ${mode}\n---\nRole`,
        "/agents/test.md",
        "project",
      );
      assert.equal(agent.promptMode, mode);
      assert.equal(agent.systemPrompt, "Role");
    }
  }
});

test("prompt_mode rejects invalid values with the source path", () => {
  for (const value of [
    "typo",
    "Replace",
    "APPEND",
    "null",
    "false",
    "123",
    '""',
    '" "',
    "[]",
    "[append]",
    "{}",
  ]) {
    assert.throws(
      () =>
        parseAgentDefinition(
          `---\nprompt_mode: ${value}\n---\nRole`,
          "/agents/test.md",
          "project",
        ),
      /Invalid agent \/agents\/test\.md: prompt_mode/,
    );
  }
});

test("prompt_mode syntax is parsed independently of runtime support", () => {
  for (const runtime of ["codex", "future-runtime"]) {
    for (const mode of ["replace", "append"]) {
      const agent = parseAgentDefinition(
        `---\nruntime: ${runtime}\nprompt_mode: ${mode}\n---\nRole`,
        "/agents/test.md",
        "project",
      );
      assert.equal(agent.runtime, runtime);
      assert.equal(agent.promptMode, mode);
    }
    assert.equal(
      parseAgentDefinition(
        `---\nruntime: ${runtime}\n---\nRole`,
        "/agents/test.md",
        "project",
      ).runtime,
      runtime,
    );
  }
});

test("runtime-specific frontmatter is retained without interpreting it in the common parser", () => {
  for (const args of ["review, search", "[review, search]", "123"]) {
    const agent = parseAgentDefinition(
      `---\nruntime: codex\nruntime_args: ${args}\n---\nReviewer`,
      "/agents/reviewer.md",
      "global",
    );
    assert.deepEqual(agent.runtimeConfig, {
      runtime_args:
        args === "123"
          ? 123
          : args.startsWith("[")
            ? ["review", "search"]
            : args,
    });
  }
  assert.equal(
    parseAgentDefinition("Role", "/agents/plain.md", "global").runtimeConfig,
    undefined,
  );
});

test("unknown fields are ignored without activating unsupported capabilities", () => {
  const baseline = parseAgentDefinition("Role", "/agents/test.md", "project");
  for (const fields of [
    "extensions: [untrusted.ts]",
    "skills: true",
    "max_turns: 30",
    "memory: project",
    "isolation: worktree",
    "future_field: { nested: [1, 2] }",
  ]) {
    assert.deepEqual(
      parseAgentDefinition(
        `---\n${fields}\n---\nRole`,
        "/agents/test.md",
        "project",
      ),
      baseline,
    );
  }
});

test("tool names can select native CLI and whitelisted extension tools", () => {
  const agent = parseAgentDefinition(
    "---\ntools: read, codemode, tool_search, web_search\n---\nPrompt",
    "/agents/explorer.md",
    "global",
  );
  assert.deepEqual(agent.tools, [
    "read",
    "codemode",
    "tool_search",
    "web_search",
  ]);
});

test("thinking levels and tool naming conventions are owned by Pi, not the agent parser", () => {
  const agent = parseAgentDefinition(
    '---\nthinking: future-level\ntools: ["123tool", "native/tool"]\n---\nRole',
    "/agents/test.md",
    "project",
  );
  assert.equal(agent.thinking, "future-level");
  assert.deepEqual(agent.tools, ["123tool", "native/tool"]);
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

test("invalid values for supported fields and malformed YAML still fail closed", () => {
  for (const fields of [
    'tools: ["a,b"]',
    'tools: ["a\\nb"]',
    "tools: null",
    "tools: 123",
    "tools: [false]",
    "thinking: false",
    "model: false",
    "enabled: yes",
    "run_in_background: nope",
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
  mkdirSync(join(f.cwd, ".pi", "agent", "agents", "directory.md"));
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
