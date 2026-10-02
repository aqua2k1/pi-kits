import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../test-utils/agent-dir.ts";
import statsExtension from "./index.ts";

for (const usage of [
  undefined,
  { enabled: false },
  { stats: { enabled: false } },
  { stats: { enabled: true } },
]) {
  test(`stats factory respects configuration ${JSON.stringify(usage)}`, (t) => {
    useAgentDir(t, usage === undefined ? undefined : { usage });
    const commands: string[] = [];
    statsExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {
        assert.fail("Stats must not register lifecycle hooks");
      },
      registerFlag() {
        assert.fail("Stats must not register flags");
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(
      commands,
      usage?.enabled === false || usage?.stats?.enabled === false
        ? []
        : ["stats"],
    );
  });
}
