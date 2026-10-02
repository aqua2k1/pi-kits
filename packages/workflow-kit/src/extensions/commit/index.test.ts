import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { useAgentDir } from "../../test-utils/agent-dir.ts";
import { lastModelPath, readLastModel, writeLastModel } from "./core.ts";
import commitExtension from "./index.ts";

type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

function captureRegistrations(
  t: TestContext,
  flag: unknown = false,
  config?: unknown,
) {
  const agentDir = useAgentDir(t, config);
  const flags: Array<[string, unknown]> = [];
  const messages: Array<[string, unknown]> = [];
  const events = new Map<string, (event: { reason: string }) => void>();
  const commands = new Map<string, Command>();
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.push([name, options]);
    },
    getFlag: () => flag,
    on(name: string, handler: (event: { reason: string }) => void) {
      events.set(name, handler);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as Command);
    },
    sendUserMessage(message: string, options: unknown) {
      messages.push([message, options]);
    },
  } as unknown as ExtensionAPI;
  commitExtension(pi);
  return { flags, messages, events, commands, agentDir };
}

test("commit factory keeps /commit, the boolean flag and startup hook", (t) => {
  const { flags, events, commands } = captureRegistrations(t);
  assert.deepEqual(flags, [
    [
      "commit",
      {
        description: "Run the commit flow at startup",
        type: "boolean",
        default: false,
      },
    ],
  ]);
  assert.deepEqual([...commands.keys()], ["commit"]);
  assert.deepEqual([...events.keys()], ["session_start"]);
});

test("--commit dispatches /commit only on startup and only when true", (t) => {
  for (const flag of [false, undefined, "true", true]) {
    for (const reason of ["new", "resume", "fork", "startup"]) {
      const { events, messages } = captureRegistrations(t, flag);
      const start = events.get("session_start");
      assert.ok(start);
      start({ reason });
      assert.deepEqual(
        messages,
        flag === true && reason === "startup"
          ? [["/commit", { expandPromptTemplates: true }]]
          : [],
      );
    }
  }
});

test("/commit refuses non-interactive execution without requesting shutdown", async (t) => {
  const { events, commands } = captureRegistrations(t, true);
  events.get("session_start")?.({ reason: "startup" });
  const command = commands.get("commit");
  assert.ok(command);
  const notifications: Array<[string, string]> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, type: string) {
        notifications.push([message, type]);
      },
    },
    shutdown() {
      assert.fail("A failed/cancelled startup commit must not shut down Pi");
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("", ctx);
  assert.deepEqual(notifications, [["commit 需要交互式界面", "warning"]]);
});

test("disabled workflow kit or commit feature registers no command, flag or hook", (t) => {
  for (const workflow of [{ enabled: false }, { commit: { enabled: false } }]) {
    const h = captureRegistrations(t, true, { workflow });
    assert.deepEqual(h.flags, []);
    assert.equal(h.events.size, 0);
    assert.equal(h.commands.size, 0);
    assert.deepEqual(h.messages, []);
  }
});

function stagedRepo(t: TestContext, agentDir: string, generator: string) {
  const cwd = path.join(agentDir, "repo");
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "change.txt"), "staged content\n");
  execFileSync("git", ["add", "change.txt"], { cwd });
  const bin = path.join(agentDir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), generator, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  return cwd;
}

function interceptNotifications(t: TestContext): string[][] {
  const notifications: string[][] = [];
  const mock = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    notifications.push(args[1] as string[]);
    (args.at(-1) as (error: null) => void)(null);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return notifications;
}

function commandContext(
  cwd: string,
  select: (title: string, options: string[]) => string | undefined,
  messages: string[] = [],
): ExtensionCommandContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: true,
    model: { provider: "p", id: "current" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "p", id: "other" },
        { provider: "p", id: "current" },
        { provider: "p", id: "remembered" },
      ],
    },
    ui: {
      confirm: async () => true,
      select: async (title: string, options: string[]) =>
        select(title, options),
      setStatus: () => undefined,
      notify: (message: string) => messages.push(message),
    },
  } as unknown as ExtensionCommandContext;
}

for (const rememberModel of [true, false]) {
  test(`configured commit model, thinking, timeout and memory (${rememberModel}) reach the flow`, async (t) => {
    const h = captureRegistrations(t, false, {
      workflow: {
        commit: {
          model: "configured/not-in-registry",
          thinking: "high",
          timeoutMs: 4_321,
          rememberModel,
        },
        notify: { enabled: false },
      },
    });
    writeLastModel("p/remembered", h.agentDir);
    const state = fs.readFileSync(lastModelPath(h.agentDir), "utf8");
    const argvPath = path.join(h.agentDir, "argv.json");
    const cwd = stagedRepo(
      t,
      h.agentDir,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("feat: configured generation"));
`,
    );
    const notifications = interceptNotifications(t);
    const timers = t.mock.method(globalThis, "setTimeout");
    const reads = t.mock.method(fs, "readFileSync");
    syncBuiltinESMExports();
    t.after(() => {
      reads.mock.restore();
      syncBuiltinESMExports();
    });
    let selections = 0;
    const ctx = commandContext(cwd, (_title, options) => {
      if (selections++ === 0) {
        assert.equal(options[0], "configured/not-in-registry");
        return options[0];
      }
      return "取消";
    });
    const command = h.commands.get("commit");
    assert.ok(command);
    await command.handler("", ctx);
    assert.equal(selections, 2);
    assert.deepEqual(
      notifications,
      [],
      "Commit completion respects notify.enabled",
    );
    assert.ok(timers.mock.calls.some((call) => call.arguments[1] === 4_321));
    const memoryReads = reads.mock.calls.filter(
      (call) => call.arguments[0] === lastModelPath(h.agentDir),
    );
    assert.equal(memoryReads.length, rememberModel ? 2 : 0);
    reads.mock.restore();
    syncBuiltinESMExports();
    const args: string[] = JSON.parse(fs.readFileSync(argvPath, "utf8"));
    assert.equal(
      args[args.indexOf("--model") + 1],
      "configured/not-in-registry",
    );
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    if (rememberModel) {
      assert.equal(readLastModel(h.agentDir), "configured/not-in-registry");
    } else {
      assert.equal(fs.readFileSync(lastModelPath(h.agentDir), "utf8"), state);
    }
  });
}

for (const rememberModel of [true, false]) {
  test(`without configured model, picker uses ${rememberModel ? "memory" : "current model"}`, async (t) => {
    const h = captureRegistrations(t, false, {
      workflow: { commit: { rememberModel } },
    });
    writeLastModel("p/remembered", h.agentDir);
    const cwd = stagedRepo(t, h.agentDir, "#!/usr/bin/env node\n");
    const ctx = commandContext(cwd, (_title, options) => {
      assert.equal(options[0], rememberModel ? "p/remembered" : "p/current");
      return undefined;
    });
    const command = h.commands.get("commit");
    assert.ok(command);
    await command.handler("", ctx);
    assert.equal(readLastModel(h.agentDir), "p/remembered");
  });
}

test("commit configured timeout terminates generation without a completion notification", async (t) => {
  const h = captureRegistrations(t, false, {
    workflow: { commit: { timeoutMs: 1_000, rememberModel: false } },
  });
  const cwd = stagedRepo(
    t,
    h.agentDir,
    `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => undefined, 60_000);
`,
  );
  const notifications = interceptNotifications(t);
  const messages: string[] = [];
  const ctx = commandContext(cwd, (_title, options) => options[0], messages);
  const command = h.commands.get("commit");
  assert.ok(command);
  await command.handler("", ctx);
  assert.ok(messages.some((message) => message.includes("生成超时")));
  assert.deepEqual(notifications, []);
});

test("commit generation still actively notifies when workflow notifications are enabled", async (t) => {
  const h = captureRegistrations(t, false, {
    workflow: {
      commit: { rememberModel: false },
      notify: { enabled: true },
    },
  });
  const cwd = stagedRepo(
    t,
    h.agentDir,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("feat: notification"));
`,
  );
  const notifications = interceptNotifications(t);
  let selections = 0;
  const ctx = commandContext(cwd, (_title, options) =>
    selections++ === 0 ? options[0] : "取消",
  );
  const command = h.commands.get("commit");
  assert.ok(command);
  await command.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0]?.includes("commit message done!"));
});
