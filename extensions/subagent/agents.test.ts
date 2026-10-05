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
    "---\nmodel: global-model\nthinking: high\nruntime_config:\n  tools: read\n  prompt_mode: append\n---\nGlobal prompt",
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
  assert.equal(reviewer.runtimeConfig, undefined);
  assert.equal(reviewer.thinking, undefined);
  assert.equal(agents.get("other")?.source, "global");
  f.file("project", "reviewer.md", "Updated prompt");
  assert.equal(
    resolveAgentDefinition(f.cwd, "reviewer", f.agentDir).systemPrompt,
    "Updated prompt",
  );
});

test("project replacements skip invalid or oversized global contents", (t) => {
  const f = fixture(t);
  f.file("global", "review.md", "---\nruntime_config: 123\n---\nGlobal prompt");
  f.file("global", "large.md", "x".repeat(64 * 1024 + 1));
  f.file(
    "project",
    "review.md",
    "---\nruntime_config:\n  tools: none\n---\nProject prompt",
  );
  f.file("project", "large.md", "Project prompt");
  const agents = loadAgentDefinitions(f.cwd, f.agentDir);
  assert.equal(agents.get("review")?.source, "project");
  assert.deepEqual(agents.get("review")?.runtimeConfig, { tools: "none" });
  assert.equal(agents.get("large")?.systemPrompt, "Project prompt");
  f.file(
    "project",
    "review.md",
    "---\nruntime_config: 123\n---\nInvalid project",
  );
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

test("Markdown frontmatter supports generic metadata and an opaque runtime config", () => {
  const agent = parseAgentDefinition(
    `---
runtime: future-runtime
description: Security reviewer
display_name: Auditor
model: provider/model
thinking: max
runtime_config:
  tools: [read, bash, read]
  disallowed_tools: edit, write
  prompt_mode: append
  inherit_context: true
enabled: false
run_in_background: false
keep_alive: true
---

Review carefully.
`,
    "/agents/auditor.md",
    "global",
  );
  assert.equal(agent.name, "auditor");
  assert.equal(agent.description, "Security reviewer");
  assert.equal(agent.displayName, "Auditor");
  assert.equal(agent.runtime, "future-runtime");
  assert.equal(agent.model, "provider/model");
  assert.equal(agent.thinking, "max");
  assert.deepEqual(agent.runtimeConfig, {
    tools: ["read", "bash", "read"],
    disallowed_tools: "edit, write",
    prompt_mode: "append",
    inherit_context: true,
  });
  assert.equal(agent.enabled, false);
  assert.equal(agent.systemPrompt, "Review carefully.");
  assert.equal(agent.runInBackground, false);
  assert.equal(agent.keepAlive, true);
  for (const field of [
    "tools",
    "disallowedTools",
    "promptMode",
    "inheritContext",
  ]) {
    assert.equal(Object.hasOwn(agent, field), false);
  }
});

test("plain Markdown uses generic defaults and omits runtime config", () => {
  const agent = parseAgentDefinition("Role", "/agents/plain.md", "global");
  assert.equal(agent.name, "plain");
  assert.equal(agent.description, "plain");
  assert.equal(agent.systemPrompt, "Role");
  assert.equal(agent.enabled, true);
  assert.equal(agent.runtime, undefined);
  assert.equal(agent.runtimeConfig, undefined);
  assert.equal(Object.hasOwn(agent, "runtimeConfig"), false);
});

test("runtime_config preserves opaque values without runtime-specific validation", () => {
  const config = {
    runtime_args: ["review", "search", 123],
    tools: ["read", "read", "a,b", false],
    disallowed_tools: null,
    prompt_mode: { arbitrary: "future-mode" },
    future_field: {
      nested: [1, true, null, { value: "  unchanged  " }],
    },
  };
  for (const runtime of [
    "",
    "runtime: pi\n",
    "runtime: codex\n",
    "runtime: future-runtime\n",
  ]) {
    const agent = parseAgentDefinition(
      `---\n${runtime}runtime_config: ${JSON.stringify(config)}\n---\nRole`,
      "/agents/test.md",
      "project",
    );
    assert.deepEqual(agent.runtimeConfig, config);
    assert.equal(agent.systemPrompt, "Role");
  }
  for (const value of ["review, search", ["review", "search"], 123, null]) {
    const config = { runtime_args: value, tools: value, prompt_mode: value };
    assert.deepEqual(
      parseAgentDefinition(
        `---\nruntime_config: ${JSON.stringify(config)}\n---\nRole`,
        "/agents/test.md",
        "project",
      ).runtimeConfig,
      config,
    );
  }
});

test("runtime_config accepts empty and custom-only maps", () => {
  for (const config of [{}, { custom_future_field: { nested: [1, 2] } }]) {
    assert.deepEqual(
      parseAgentDefinition(
        `---\nruntime_config: ${JSON.stringify(config)}\n---\nRole`,
        "/agents/test.md",
        "project",
      ).runtimeConfig,
      config,
    );
  }
});

test("runtime_config rejects non-object values with the source path", () => {
  for (const value of [
    "",
    "null",
    "~",
    "false",
    "true",
    "123",
    '"text"',
    '""',
    "[]",
    "[{}]",
  ]) {
    assert.throws(
      () =>
        parseAgentDefinition(
          `---\nruntime_config: ${value}\n---\nRole`,
          "/agents/test.md",
          "project",
        ),
      /Invalid agent \/agents\/test\.md: runtime_config must be a non-null plain object/,
    );
  }
});

test("foreign and unknown top-level fields are ignored regardless of value", () => {
  const baseline = parseAgentDefinition("Role", "/agents/test.md", "project");
  for (const field of [
    "runtime_args",
    "tools",
    "disallowed_tools",
    "prompt_mode",
    "inherit_context",
    "extensions",
    "skills",
    "max_turns",
    "memory",
    "isolation",
    "future_field",
    "name",
    "system_prompt",
    "runtimeConfig",
    "constructor",
    "__proto__",
  ]) {
    for (const value of [
      null,
      true,
      false,
      123,
      "",
      "foreign",
      [],
      { nested: [1, 2] },
    ]) {
      assert.deepEqual(
        parseAgentDefinition(
          `---\n${field}: ${JSON.stringify(value)}\n---\nRole`,
          "/agents/test.md",
          "project",
        ),
        baseline,
      );
    }
  }
});

test("legacy top-level runtime fields do not override or merge into runtime_config", () => {
  const config = {
    runtime_args: ["nested"],
    tools: ["read"],
    disallowed_tools: ["write"],
    prompt_mode: "append",
    inherit_context: false,
    future_field: { nested: [null, 123] },
  };
  const metadata = `runtime: future-runtime
description: Reviewer
model: provider/model
thinking: high
runtime_config: ${JSON.stringify(config)}`;
  const baseline = parseAgentDefinition(
    `---\n${metadata}\n---\nRole`,
    "/agents/test.md",
    "project",
  );
  const agent = parseAgentDefinition(
    `---
${metadata}
runtime_args: [top-level]
tools: false
disallowed_tools: { invalid: true }
prompt_mode: [invalid]
inherit_context: true
future_field: { top_level: true }
---
Role`,
    "/agents/test.md",
    "project",
  );
  assert.deepEqual(agent, baseline);
  assert.deepEqual(agent.runtimeConfig, config);
});

test("thinking levels are not restricted by the agent parser", () => {
  const agent = parseAgentDefinition(
    "---\nthinking: future-level\n---\nRole",
    "/agents/test.md",
    "project",
  );
  assert.equal(agent.thinking, "future-level");
});

test("invalid generic values and malformed YAML still fail closed", () => {
  for (const field of [
    "runtime",
    "description",
    "display_name",
    "model",
    "thinking",
  ]) {
    for (const value of ["null", "false", "123", '""', '" "', "[]", "{}"]) {
      assert.throws(
        () =>
          parseAgentDefinition(
            `---\n${field}: ${value}\n---\nPrompt`,
            "/agents/bad.md",
            "project",
          ),
        /Invalid agent \/agents\/bad\.md: .* must be a non-empty string/,
      );
    }
  }
  for (const field of ["enabled", "run_in_background", "keep_alive"]) {
    for (const value of ["null", "yes", "1", '""', "[]", "{}"]) {
      assert.throws(
        () =>
          parseAgentDefinition(
            `---\n${field}: ${value}\n---\nPrompt`,
            "/agents/bad.md",
            "project",
          ),
        /Invalid agent \/agents\/bad\.md: .* must be a boolean/,
      );
    }
  }
  for (const invalid of [
    "---\nruntime_config: [\n---\nPrompt",
    "---\ndescription: unfinished",
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
  f.file("project", "review.md", "---\nruntime_config: 123\n---\nProject");
  assert.throws(() => loadAgentDefinitions(f.cwd, f.agentDir), /Invalid agent/);
  f.file("project", "review.md", "x".repeat(65 * 1024));
  assert.throws(() => loadAgentDefinitions(f.cwd, f.agentDir), /limit 64 KiB/);
});
