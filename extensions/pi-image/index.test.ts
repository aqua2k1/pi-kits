import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  initTheme,
  keyHint,
  keyText,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type ImageArtifact, isImageArtifact, saveImage } from "./images.ts";
import imageExtension, { branchImages } from "./index.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
const source = {
  provider: "openai",
  api: "openai-responses",
  model: "image-model",
  responseId: "resp-original",
};
const item = {
  id: "img-1",
  type: "image_generation_call",
  status: "completed",
  result: PNG,
};

type Handler = (...args: unknown[]) => unknown;
type Command = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};
type Message = Parameters<ExtensionAPI["sendMessage"]>[0];

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-image-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const renderers = new Map<string, MessageRenderer<ImageArtifact>>();
  const messages: { message: Message; options: unknown }[] = [];
  const branch: unknown[] = [];
  const sender = { send: (_text: string): void => {} };
  const ctx = {
    model: { provider: source.provider, api: source.api, id: source.model },
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionDir: () => dir,
      getSessionId: () => "session-1",
    },
    ui: {
      notify: () => assert.fail("unexpected notification"),
      select: () => assert.fail("a single image must not open a selector"),
    },
  } as unknown as ExtensionCommandContext;
  imageExtension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    registerMessageRenderer: (
      name: string,
      renderer: MessageRenderer<ImageArtifact>,
    ) => renderers.set(name, renderer),
    sendMessage: (message: Message, options: unknown) =>
      messages.push({ message, options }),
    sendUserMessage: (text: string) => sender.send(text),
  } as unknown as ExtensionAPI);
  function emit(name: string, event: unknown = {}) {
    const handler = handlers.get(name);
    assert.ok(handler, name);
    return handler(event, ctx);
  }
  async function stream(data: unknown) {
    await emit("provider_stream_event", { ...source, data });
  }
  async function seed() {
    const artifact = await saveImage(dir, item, source);
    branch.push({
      type: "custom_message",
      customType: "pi-image",
      details: artifact,
    });
    return artifact;
  }
  async function edit() {
    const command = commands.get("image-edit");
    assert.ok(command);
    await command.handler("  make it blue  ", ctx);
  }
  return {
    dir,
    ctx,
    messages,
    branch,
    renderers,
    handlers,
    sender,
    emit,
    stream,
    seed,
    edit,
  };
}

test("saves a complete PNG once across done/completed, without base64 in messages", async (t) => {
  const h = await setup(t);
  await h.stream({
    type: "response.created",
    response: { id: source.responseId },
  });
  await h.stream({
    type: "response.image_generation_call.partial_image",
    item_id: item.id,
    partial_image_b64: PNG,
  });
  assert.equal(h.messages.length, 0);
  await h.stream({ type: "response.output_item.done", item });
  await h.stream({
    type: "response.completed",
    response: { id: source.responseId, output: [item] },
  });
  assert.equal(h.messages.length, 1);
  const { message, options } = h.messages[0];
  assert.equal(message.customType, "pi-image");
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: false });
  assert.ok(isImageArtifact(message.details));
  const artifact = message.details;
  assert.deepEqual(artifact, {
    ...source,
    itemId: item.id,
    path: artifact.path,
    mimeType: "image/png",
  });
  assert.equal(join(artifact.path, ".."), join(h.dir, "images", "session-1"));
  assert.deepEqual(await readFile(artifact.path), Buffer.from(PNG, "base64"));
  assert.equal((await readdir(join(h.dir, "images", "session-1"))).length, 1);
  assert.equal(JSON.stringify(h.messages).includes(PNG), false);
  assert.equal(JSON.stringify(message).includes('"result"'), false);

  h.branch.push({ type: "custom_message", ...message });
  await h.emit("session_start");
  await h.stream({
    type: "response.completed",
    response: { id: source.responseId, output: [item] },
  });
  assert.equal(
    h.messages.length,
    1,
    "persisted branch images are also deduplicated",
  );
  assert.deepEqual(branchImages(h.ctx), [artifact]);
});

test("invalid image produces a deduplicated error message", async (t) => {
  const h = await setup(t);
  const invalid = {
    ...item,
    result: Buffer.from("not an image").toString("base64"),
  };
  await h.stream({
    type: "response.created",
    response: { id: source.responseId },
  });
  await h.stream({ type: "response.output_item.done", item: invalid });
  await h.stream({
    type: "response.completed",
    response: { id: source.responseId, output: [invalid] },
  });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.customType, "pi-image-error");
  assert.match(String(h.messages[0].message.content), /图片保存失败：.+/);
  assert.equal(h.messages[0].message.display, true);
  assert.deepEqual(h.messages[0].options, { triggerTurn: false });
  assert.equal(h.messages[0].message.details, undefined);
});

test("single-image edit injects its response reference and preserves unrelated payload fields", async (t) => {
  const h = await setup(t);
  await h.seed();
  const payload = {
    model: source.model,
    input: [{ role: "user", content: "old history" }],
    tools: [
      { type: "function", name: "read" },
      { type: "image_generation", quality: "high" },
    ],
    temperature: 0.5,
  };
  const original = structuredClone(payload);
  const requests: unknown[] = [];
  const prompts: string[] = [];
  h.sender.send = (text) => {
    prompts.push(text);
    requests.push(h.emit("before_provider_request", { payload }));
  };
  await h.edit();
  assert.deepEqual(prompts, ["make it blue"]);
  assert.deepEqual(requests, [
    {
      ...payload,
      previous_response_id: source.responseId,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "make it blue" }],
        },
      ],
      tools: [
        { type: "function", name: "read" },
        { type: "image_generation", quality: "high", action: "edit" },
      ],
      tool_choice: { type: "image_generation" },
    },
  ]);
  assert.deepEqual(payload, original);
  await h.emit("agent_settled");
  assert.equal(await h.emit("before_provider_request", { payload }), undefined);
});

test("failed edit propagates the error without retry and clears pending state", async (t) => {
  const h = await setup(t);
  await h.seed();
  const error = new Error("previous_response_id expired");
  let calls = 0;
  h.sender.send = () => {
    calls++;
    const request = h.emit("before_provider_request", { payload: {} });
    assert.equal(
      (request as Record<string, unknown>).previous_response_id,
      source.responseId,
    );
    throw error;
  };
  await assert.rejects(h.edit(), (caught) => caught === error);
  assert.equal(calls, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(
    await h.emit("before_provider_request", { payload: {} }),
    undefined,
  );
  h.sender.send = () => {
    calls++;
  };
  await h.edit();
  assert.equal(calls, 2, "a new explicit edit is not blocked after failure");
});

for (const event of ["agent_settled", "session_shutdown"]) {
  test(`${event} clears an in-flight edit`, async (t) => {
    const h = await setup(t);
    await h.seed();
    let calls = 0;
    h.sender.send = () => {
      calls++;
      assert.ok(h.emit("before_provider_request", { payload: {} }));
      h.emit(event);
      assert.equal(
        h.emit("before_provider_request", { payload: {} }),
        undefined,
      );
    };
    await h.edit();
    assert.equal(calls, 1);
  });
}

test("provider failure settles without fallback or retry", async (t) => {
  const h = await setup(t);
  await h.seed();
  const requests: unknown[] = [];
  h.sender.send = () => {
    requests.push(h.emit("before_provider_request", { payload: {} }));
  };
  await h.edit();
  await h.handlers.get("message_end")?.(
    {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "response expired",
      },
    },
    h.ctx,
  );
  await h.emit("agent_settled");
  assert.equal(requests.length, 1);
  assert.equal(
    (requests[0] as Record<string, unknown>).previous_response_id,
    source.responseId,
  );
  assert.equal(h.messages.length, 0);
  assert.equal(h.emit("before_provider_request", { payload: {} }), undefined);
});

test("session shutdown clears response ID and deduplication state", async (t) => {
  const h = await setup(t);
  await h.stream({
    type: "response.created",
    response: { id: source.responseId },
  });
  await h.stream({ type: "response.output_item.done", item });
  await h.emit("session_shutdown");
  await h.stream({ type: "response.output_item.done", item });
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].message.customType, "pi-image-error");
  assert.match(String(h.messages[1].message.content), /缺少所属 response ID/);
});

test("ordinary payloads pass through unchanged", async (t) => {
  const h = await setup(t);
  for (const payload of [null, "text", [], { input: ["hello"], tools: [] }]) {
    const original = structuredClone(payload);
    assert.equal(
      await h.emit("before_provider_request", { payload }),
      undefined,
    );
    assert.deepEqual(payload, original);
  }
});

test("registered renderer falls back when the saved file is missing", async (t) => {
  const h = await setup(t);
  const artifact = await h.seed();
  await rm(artifact.path);
  initTheme("dark", false);
  const { getThemeByName } = await import(
    new URL(
      "./modes/interactive/theme/theme.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href
  );
  const theme = getThemeByName("dark");
  assert.ok(theme);
  const renderer = h.renderers.get("pi-image");
  assert.ok(renderer);
  const component = renderer(
    {
      role: "custom",
      customType: "pi-image",
      content: "",
      display: true,
      details: artifact,
      timestamp: 0,
    },
    { expanded: false, outputPad: 0, keyHint, keyText },
    theme,
  );
  assert.ok(component);
  const text = stripTerminalSequences(component.render(200).join("\n"));
  assert.ok(text.includes(artifact.path));
  assert.match(text, /图片无法读取/);
  assert.equal(text.includes(PNG), false);
});
