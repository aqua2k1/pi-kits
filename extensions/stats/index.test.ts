import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../tests/helpers/agent-dir.ts";
import statsExtension from "./index.ts";

function commandHandler() {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  statsExtension({
    registerCommand(_name, command) {
      handler = command.handler;
    },
  } as ExtensionAPI);
  return handler;
}

test("stats closes the TUI without automatically opening HTML", async (t) => {
  const agentDir = useAgentDir(t);
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  let panels = 0;
  await commandHandler()("", {
    cwd: agentDir,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionDir: () => agentDir },
    ui: {
      setStatus: (_id: string, value: string | undefined) =>
        statuses.push(value),
      notify: (message: string) => notifications.push(message),
      custom: async () => {
        panels++;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext);
  assert.equal(panels, 1);
  assert.deepEqual(statuses, ["stats: no sessions", undefined]);
  assert.deepEqual(notifications, []);
});

test("stats reports panel failures without opening HTML", async (t) => {
  const agentDir = useAgentDir(t);
  const notifications: [string, string][] = [];
  await commandHandler()("", {
    cwd: agentDir,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionDir: () => agentDir },
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) =>
        notifications.push([message, level]),
      custom: async () => {
        throw new Error("panel unavailable");
      },
    },
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, [
    ["统计面板打开失败: panel unavailable", "error"],
  ]);
});

test("stats does not scan or mount a panel without UI", async (t) => {
  useAgentDir(t);
  const notifications: string[] = [];
  await commandHandler()("", {
    hasUI: false,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, ["stats 需要交互式界面"]);
});

for (const [config, enabled] of [
  [undefined, true],
  [{ usage: { enabled: false } }, false],
  [{ usage: { stats: { enabled: false } } }, false],
  [{ usage: { stats: { enabled: true } } }, true],
  [{ stats: { enabled: false } }, false],
  [{ stats: { enabled: true } }, true],
] as const) {
  test(`stats factory respects configuration ${JSON.stringify(config)}`, (t) => {
    useAgentDir(t, config);
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
    assert.deepEqual(commands, enabled ? ["stats"] : []);
  });
}
