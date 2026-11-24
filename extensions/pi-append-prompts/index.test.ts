import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import appendPrompts, { loadAppendPrompts } from "./index.ts";

test("loads markdown files in sorted order and ignores blank or non-markdown files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-append-prompts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.md"), "# Second\n- B\n");
  writeFileSync(join(dir, "a.md"), "  # First\n- A  \n");
  writeFileSync(join(dir, "empty.md"), "   \n");
  writeFileSync(join(dir, "notes.txt"), "ignored");

  assert.equal(loadAppendPrompts(dir), "# First\n- A\n\n# Second\n- B");
});

test("appends loaded prompts after existing appendSystemPrompt on before_agent_start", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-append-prompts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.md"), "# Rule\n- Keep it short.");

  const handlers = new Map<string, (event: unknown) => void>();
  appendPrompts(
    {
      on(event: string, handler: (event: unknown) => void) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
    dir,
  );

  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  const handler = handlers.get("before_agent_start");
  assert.ok(handler);

  const emptyEvent = { systemPromptOptions: { appendSystemPrompt: "" } };
  handler(emptyEvent);
  assert.equal(
    emptyEvent.systemPromptOptions.appendSystemPrompt,
    "# Rule\n- Keep it short.",
  );

  const existingEvent = {
    systemPromptOptions: { appendSystemPrompt: "# Project\n- Local rule." },
  };
  handler(existingEvent);
  assert.equal(
    existingEvent.systemPromptOptions.appendSystemPrompt,
    "# Project\n- Local rule.\n\n# Rule\n- Keep it short.",
  );
});

test("registers no hook when prompts directory is empty or missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-append-prompts-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let registered = 0;
  const pi = {
    on() {
      registered++;
    },
  } as unknown as ExtensionAPI;

  appendPrompts(pi, dir);
  appendPrompts(pi, join(dir, "missing"));
  assert.equal(registered, 0);
});
