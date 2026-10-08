import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
type RecordMessage = {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
  placeholder?: string;
  message?: string;
  notifyType?: string;
  command?: string;
  success?: boolean;
  data?: {
    disposition?: string;
    commands?: { name: string; source: string }[];
    messages?: unknown[];
  };
};

function extensionSource(): string {
  const path = (relative: string) => JSON.stringify(join(root, relative));
  return `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type UIView } from ${path("shared/ui/protocol/index.ts")};
import { createUISession } from ${path("shared/ui/session/index.ts")};
import { createPiDialogAdapter } from ${path("shared/ui/adapters/pi-dialog/index.ts")};

export default function (pi: ExtensionAPI) {
  let saved = "unsaved";
  let runs = 0;
  pi.registerCommand("ui-dialog-smoke", {
    handler: async (_args, ctx) => {
      const contentOnly = ++runs === 2;
      let draft = "initial";
      const view = (revision: number): UIView => ({
        id: "smoke",
        revision,
        root: contentOnly
          ? { kind: "content", id: "body", format: "text", body: "Content only" }
          : {
              kind: "group", id: "root", title: "Smoke",
              children: [
                { kind: "field", id: "value", type: "text", label: "Value", value: draft, placeholder: "Enter value" },
                { kind: "action", id: "save", label: "Save" },
              ],
            },
      });
      const session = createUISession(view(0), {
        adapter: createPiDialogAdapter(ctx.ui),
        onEvent(event, current) {
          if (event.type === "change") {
            if (event.nodeId !== "value" || typeof event.value !== "string" || event.revision !== 0) {
              throw new Error("Unexpected change");
            }
            draft = event.value;
            current.publish(view(event.revision + 1));
          } else if (event.type === "invoke") {
            if (event.nodeId !== "save" || event.revision !== 1) throw new Error("Unexpected invoke");
            saved = draft;
            current.close("completed");
          } else {
            current.close("dismissed");
          }
        },
      });
      const { status } = await session.closed;
      ctx.ui.notify(\`smoke:\${status}:\${saved}\`, "info");
    },
  });
}
`;
}

test("installed Pi RPC drives dialog session edits, save and content dismissal offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dialog-rpc-"));
  let child: ReturnType<typeof spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stderr = "";
  let stopping = false;
  let childClosed = false;
  let processClosed = Promise.resolve();
  let signalFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => {
    signalFailure = resolve;
  });
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const records: RecordMessage[] = [];
  const fail = (error: Error) => {
    failure ??= error;
    signalFailure(failure);
    wake?.();
  };
  const diagnostic = () => `\nPi stderr:\n${stderr || "(empty)"}`;
  const guarded = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([
      operation,
      failed.then((error) => {
        throw new Error(error.message + diagnostic());
      }),
    ]);
  try {
    const extension = join(dir, "smoke.ts");
    writeFileSync(extension, extensionSource());
    child = spawn(
      process.execPath,
      [
        join(
          root,
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--no-tools",
        "--offline",
        "-e",
        extension,
      ],
      {
        cwd: dir,
        // No inherited credentials, agent settings, project resources or user HOME.
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          PI_CODING_AGENT_DIR: dir,
          PI_OFFLINE: "1",
          TMPDIR: dir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    processClosed = new Promise<void>((resolve) => {
      child?.once("close", (code, signal) => {
        childClosed = true;
        if (!stopping) fail(new Error(`Pi exited: ${code}, ${signal}`));
        resolve();
      });
    });
    child.on("error", fail);
    assert.ok(child.stdin && child.stdout && child.stderr);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-32_768);
    });
    // setEncoding preserves split UTF-8 codepoints; only LF frames records.
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let lf = buffer.indexOf("\n");
      while (lf !== -1) {
        const line = buffer.slice(0, lf).replace(/\r$/, "");
        buffer = buffer.slice(lf + 1);
        try {
          const record = JSON.parse(line) as RecordMessage;
          if (record.type === "response" && !record.success) {
            fail(new Error(`RPC rejected command: ${line}`));
          } else if (record.type.startsWith("agent_")) {
            fail(new Error(`Unexpected model run: ${line}`));
          } else {
            records.push(record);
          }
        } catch {
          fail(new Error(`Invalid RPC JSONL: ${line}`));
        }
        lf = buffer.indexOf("\n");
      }
      wake?.();
    });
    deadline = setTimeout(
      () => fail(new Error("RPC smoke deadline exceeded")),
      30_000,
    );
    const next = async (matches: (record: RecordMessage) => boolean) => {
      for (;;) {
        if (failure) throw new Error(failure.message + diagnostic());
        const index = records.findIndex(matches);
        if (index !== -1) return records.splice(index, 1)[0];
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    };
    const send = async (record: object) => {
      if (failure) throw new Error(failure.message + diagnostic());
      await guarded(
        new Promise<void>((resolve, reject) => {
          child?.stdin?.write(`${JSON.stringify(record)}\n`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
      );
    };
    const response = (id: string) =>
      next((record) => record.type === "response" && record.id === id);
    const ui = (method: string) =>
      next(
        (record) =>
          record.type === "extension_ui_request" && record.method === method,
      );
    const answer = async (request: RecordMessage, value?: string) => {
      assert.equal(typeof request.id, "string");
      await send({
        type: "extension_ui_response",
        id: request.id,
        ...(value === undefined ? { cancelled: true } : { value }),
      });
    };

    await send({ id: "commands", type: "get_commands" });
    const commands = await response("commands");
    assert.ok(
      commands.data?.commands?.some(
        (command) =>
          command.name === "ui-dialog-smoke" && command.source === "extension",
      ),
      `Temporary command did not load${diagnostic()}`,
    );
    // This installed RPC API takes message: string, not a content-block array.
    await send({ id: "save", type: "prompt", message: "/ui-dialog-smoke" });
    const main = await ui("select");
    assert.deepEqual(main.options, ["1. Edit: Value", "2. Save", "3. Close"]);
    await answer(main, main.options[0]);
    const input = await ui("input");
    assert.match(input.title ?? "", /Current value: initial/);
    assert.equal(input.placeholder, "Enter value");
    const value = "业务值😀\u2028line\u2029paragraph";
    await answer(input, value);
    const updated = await ui("select");
    assert.ok(updated.title?.includes(value));
    assert.deepEqual(updated.options, main.options);
    await answer(updated, updated.options?.[1]);
    const saved = await ui("notify");
    assert.equal(saved.notifyType, "info");
    assert.equal(saved.message, `smoke:completed:${value}`);
    assert.equal((await response("save")).data?.disposition, "handled");

    await send({ id: "dismiss", type: "prompt", message: "/ui-dialog-smoke" });
    const content = await ui("select");
    assert.equal(content.title, "Content only");
    assert.deepEqual(content.options, ["1. Close"]);
    await answer(content);
    const dismissed = await ui("notify");
    assert.equal(dismissed.notifyType, "info");
    assert.equal(dismissed.message, `smoke:dismissed:${value}`);
    assert.equal((await response("dismiss")).data?.disposition, "handled");
    await send({ id: "messages", type: "get_messages" });
    assert.deepEqual((await response("messages")).data?.messages, []);
    assert.doesNotMatch(
      stderr,
      /Failed to load|Extension error|Error loading/i,
    );

    stopping = true;
    child.stdin.end();
    // Shutdown shares the same whole-test deadline.
    await guarded(processClosed);
    assert.equal(child.exitCode, 0, diagnostic());
  } finally {
    stopping = true;
    if (deadline) clearTimeout(deadline);
    if (child && !childClosed) {
      child.kill("SIGKILL");
      await processClosed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
