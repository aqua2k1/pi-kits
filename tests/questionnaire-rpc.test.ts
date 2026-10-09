import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value as schemaValue } from "typebox/value";
import {
  type AskUserParams,
  AskUserResultSchema,
} from "../extensions/ask-user-question/core.ts";

const params: AskUserParams = {
  questions: [
    {
      question: "Single 业务😀\u2028line\u2029paragraph",
      options: [{ label: "A" }, { label: "A" }],
    },
    {
      question: "Multi",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }, { label: "A" }],
    },
  ],
};

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
  const interaction = JSON.stringify(
    join(root, "extensions/ask-user-question/interaction.ts"),
  );
  const host = JSON.stringify(join(root, "shared/ui/host/index.ts"));
  return `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindUIHost } from ${host};
import { askQuestions } from ${interaction};

const params = ${JSON.stringify(params)};
export default function (pi: ExtensionAPI) {
  let runs = 0;
  pi.registerCommand("questionnaire-rpc", {
    handler: async (_args, ctx) => {
      const id = "questionnaire-rpc-" + ++runs;
      const host = bindUIHost(ctx);
      try {
        const result = await askQuestions(host, params, undefined, id);
        ctx.ui.notify(JSON.stringify({ id, result }), "info");
      } finally {
        await host.dispose();
      }
    },
  });
}
`;
}

test("installed Pi RPC completes and cancels questionnaires offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "questionnaire-rpc-"));
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
    const extension = join(dir, "questionnaire.ts");
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
          } else if (
            record.type.startsWith("agent_") ||
            record.type.startsWith("tool_execution_")
          ) {
            fail(new Error(`Unexpected model/tool run: ${line}`));
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
      () => fail(new Error("RPC questionnaire deadline exceeded")),
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
          command.name === "questionnaire-rpc" &&
          command.source === "extension",
      ),
      `Temporary command did not load${diagnostic()}`,
    );
    const choose = async (request: RecordMessage, pattern: RegExp) => {
      const option = request.options?.find((label) => pattern.test(label));
      assert.ok(option, `Missing ${pattern}: ${JSON.stringify(request)}`);
      await answer(request, option);
    };
    const confirmSingle = async () => {
      const main = await ui("select");
      assert.ok(
        main.title?.startsWith(`[1/2] ${params.questions[0].question}`),
      );
      assert.ok(main.options?.every((label) => !/Confirm/.test(label)));
      await choose(main, /Edit: Selected option$/);
      const choices = await ui("select");
      assert.deepEqual(choices.options, ["1. A", "2. A", "3. Clear selection"]);
      await answer(choices, choices.options[1]);
      const selected = await ui("select");
      assert.match(selected.title ?? "", /Selected option: A/);
      await choose(selected, /Confirm answer$/);
    };
    const readResult = async (id: string) => {
      const notification = await ui("notify");
      assert.equal(notification.notifyType, "info");
      assert.equal(typeof notification.message, "string");
      const payload = JSON.parse(notification.message ?? "");
      assert.equal(payload.id, id);
      assert.equal(
        schemaValue.Check(AskUserResultSchema, payload.result),
        true,
      );
      return payload.result;
    };
    const singleAnswer = {
      questionIndex: 0,
      question: params.questions[0].question,
      kind: "option",
      answer: "A",
      optionIndex: 1,
    };

    // The command calls interaction directly, not the model-only tool or a model.
    // This installed RPC API takes message: string, not a content-block array.
    await send({
      id: "complete",
      type: "prompt",
      message: "/questionnaire-rpc",
    });
    await confirmSingle();
    const multi = await ui("select");
    assert.match(multi.title ?? "", /^\[2\/2\] Multi/);
    assert.ok(multi.options?.every((label) => !/Confirm/.test(label)));
    await choose(multi, /Edit: Selected options$/);
    const choices = await ui("select");
    assert.deepEqual(choices.options, [
      "1. [ ] A",
      "2. [ ] B",
      "3. [ ] A",
      "4. Done",
    ]);
    await answer(choices, choices.options[0]);
    const firstToggle = await ui("select");
    assert.deepEqual(firstToggle.options, [
      "1. [x] A",
      "2. [ ] B",
      "3. [ ] A",
      "4. Done",
    ]);
    await answer(firstToggle, firstToggle.options[2]);
    const bothToggled = await ui("select");
    assert.deepEqual(bothToggled.options, [
      "1. [x] A",
      "2. [ ] B",
      "3. [x] A",
      "4. Done",
    ]);
    await choose(bothToggled, /Done$/);
    const selectedMulti = await ui("select");
    assert.match(selectedMulti.title ?? "", /Selected options: A, A/);
    await choose(selectedMulti, /Confirm answer$/);
    assert.deepEqual(await readResult("questionnaire-rpc-1"), {
      answers: [
        singleAnswer,
        {
          questionIndex: 1,
          question: params.questions[1].question,
          kind: "multi",
          answer: "A, A",
          optionIndices: [0, 2],
          selected: ["A", "A"],
        },
      ],
      cancelled: false,
    });
    assert.equal((await response("complete")).data?.disposition, "handled");

    await send({ id: "cancel", type: "prompt", message: "/questionnaire-rpc" });
    await confirmSingle();
    const secondQuestion = await ui("select");
    assert.match(secondQuestion.title ?? "", /^\[2\/2\] Multi/);
    await answer(secondQuestion);
    assert.deepEqual(await readResult("questionnaire-rpc-2"), {
      answers: [singleAnswer],
      cancelled: true,
    });
    assert.equal((await response("cancel")).data?.disposition, "handled");
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
