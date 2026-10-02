import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import commitExtension from "./index.ts";

type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

function captureRegistrations(flag: unknown = false) {
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
  return { flags, messages, events, commands };
}

test("commit factory keeps /commit, the boolean flag and startup hook", () => {
  const { flags, events, commands } = captureRegistrations();
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

test("--commit dispatches /commit only on startup and only when true", () => {
  for (const flag of [false, undefined, "true", true]) {
    for (const reason of ["new", "resume", "fork", "startup"]) {
      const { events, messages } = captureRegistrations(flag);
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

test("/commit refuses non-interactive execution without requesting shutdown", async () => {
  const { events, commands } = captureRegistrations(true);
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
