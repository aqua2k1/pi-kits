import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

function runPi(args: string[], cwd: string, prefix: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.env.PI_KITS_TEST_PI ?? "pi",
      args,
      { cwd, timeout: 180_000, maxBuffer: 32 * 1_024 * 1_024 },
      (error, stdout, stderr) => {
        void Promise.all([
          writeFile(`${prefix}.jsonl`, stdout),
          writeFile(`${prefix}.stderr`, stderr),
        ]).then(() => {
          if (error) reject(error);
          else resolve(stdout);
        }, reject);
      },
    );
    // JSON mode also reads piped stdin; EOF lets the supplied prompt run.
    child.stdin?.end();
  });
}

function textContent(content: { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// Opt-in: uses real credentials. The harness observes; it never sends follow-ups
// or supplies read offsets. Only read-only tools are exposed, without codemode.
test("model autonomously chooses full-document versus targeted reading", {
  skip: process.env.PI_KITS_MODEL_READ !== "1",
  timeout: 400_000,
}, async (t) => {
  assert.ok(
    !process.env.PI_KITS_TEST_SCENARIO ||
      ["full", "targeted"].includes(process.env.PI_KITS_TEST_SCENARIO),
    "PI_KITS_TEST_SCENARIO must be full or targeted",
  );
  const artifacts = await mkdtemp(join(tmpdir(), "pi-kits-model-read-"));
  const cwd = join(artifacts, "workspace");
  await mkdir(cwd);
  const tokens = process.env.PI_KITS_TEST_TOKENS
    ? process.env.PI_KITS_TEST_TOKENS.split(",")
    : [0, 1, 2].map(() => randomUUID());
  assert.equal(tokens.length, 3);
  const lines = Array.from(
    { length: 4_501 },
    (_, i) => `Record ${i + 1}: normal.`,
  );
  for (const [index, line] of [11, 2_301, 4_401].entries()) {
    lines[line - 1] =
      `Record ${line}: EXCEPTION code=${tokens[index]}; requires manual review.`;
  }
  lines[2_302] =
    "Record 2303: retention_window_days=37; applies only to archived invoices.";
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(lines.join("\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.diagnostic(`Artifacts: ${artifacts}`);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/records.txt`;
    for (const scenario of ["full", "targeted"] as const) {
      if (
        process.env.PI_KITS_TEST_SCENARIO &&
        process.env.PI_KITS_TEST_SCENARIO !== scenario
      )
        continue;
      const prompt =
        scenario === "full"
          ? `请完整审查 ${url} 的全部记录，列出所有需要人工复核的异常代码，并说明审查范围。不要遗漏任何记录。`
          : `请查阅 ${url}，只回答 retention_window_days 的值和适用范围，无需全文审查。`;
      const args = [
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--offline",
        "-e",
        process.env.PI_KITS_TEST_EXTENSION ??
          fileURLToPath(new URL("../index.ts", import.meta.url)),
        "--tools",
        "web_fetch,read,grep",
        "--thinking",
        process.env.PI_KITS_TEST_THINKING ?? "low",
      ];
      const model = process.env.PI_KITS_TEST_MODEL ?? process.env.PI_MODEL;
      const provider =
        process.env.PI_KITS_TEST_PROVIDER ?? process.env.PI_PROVIDER;
      if (model) args.push("--model", model);
      if (model && provider) args.push("--provider", provider);
      args.push("--", prompt);
      const stdout = await runPi(args, cwd, join(artifacts, scenario));
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JsonAgentSessionEvent);
      const calls = events.filter(
        (event) => event.type === "tool_execution_start",
      );
      const ends = events.filter(
        (event) => event.type === "tool_execution_end",
      );
      const assistants = events.filter(
        (event) =>
          event.type === "message_end" && event.message.role === "assistant",
      );
      const final = assistants.at(-1);
      assert.ok(
        final?.type === "message_end" && final.message.role === "assistant",
      );
      assert.notEqual(
        final.message.stopReason,
        "error",
        final.message.errorMessage ?? "model failed",
      );
      assert.notEqual(final.message.stopReason, "aborted");
      const answer = textContent(final.message.content);
      const fetchEnd = ends.find(
        (event) => event.toolName === "web_fetch" && !event.isError,
      );
      assert.ok(fetchEnd, "model must actually fetch the document");
      const path = (
        fetchEnd.result.details as { savedContent: { path: string } }
      ).savedContent.path;
      const covered = new Set<number>();
      const ranges: { start: number; end: number }[] = [];
      for (const call of calls.filter((event) => event.toolName === "read")) {
        const input = call.args as { path: string; offset?: number };
        if (input.path !== path) continue;
        const end = ends.find((event) => event.toolCallId === call.toolCallId);
        if (!end || end.isError) continue;
        const content = textContent(end.result.content).replace(
          /\n\n\[(?:Showing lines .*|\d+ more lines in file\..*)\]$/,
          "",
        );
        const start = input.offset ?? 1;
        const delivered = content.split("\n");
        assert.deepEqual(
          delivered,
          lines.slice(start - 1, start - 1 + delivered.length),
        );
        ranges.push({ start, end: start + delivered.length - 1 });
        for (let index = 0; index < delivered.length; index++)
          covered.add(start + index);
      }
      const report = {
        scenario,
        prompt,
        model: final.message.model,
        provider: final.message.provider,
        requestedThinking: process.env.PI_KITS_TEST_THINKING ?? "low",
        tools: calls.map((call) => ({ name: call.toolName, args: call.args })),
        ranges,
        coveredLines: covered.size,
        totalLines: lines.length,
        answer,
      };
      await writeFile(
        join(artifacts, `${scenario}.report.json`),
        JSON.stringify(report, null, 2),
      );
      t.diagnostic(JSON.stringify(report));
      await t.test(scenario, () => {
        if (scenario === "full") {
          for (const token of tokens)
            assert.ok(answer.includes(token), "all hidden exceptions reported");
          assert.equal(
            covered.size,
            lines.length,
            "full review must cover every saved line through read",
          );
        } else {
          assert.match(answer, /37/);
          assert.match(answer, /归档|archived/i);
          assert.match(answer, /发票|invoices/i);
          assert.ok(
            covered.size < lines.length,
            "targeted lookup is not full read",
          );
          assert.ok(
            calls.some((call) => call.toolName === "grep"),
            "targeted lookup should search",
          );
        }
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
