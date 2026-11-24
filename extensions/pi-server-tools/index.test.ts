import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import serverTools, { injectServerTools } from "./index.ts";

function model(provider: string, api: Api, id: string): Model<Api> {
  return { provider, api, id } as Model<Api>;
}

test("injects native web_search for OpenAI and Codex Responses models", () => {
  for (const current of [
    model("openai", "openai-responses", "gpt-6"),
    model("openai-codex", "openai-codex-responses", "gpt-6-luna"),
  ]) {
    const existing = [{ type: "function", name: "read" }];
    const payload = { model: current.id, tools: existing };
    const next = injectServerTools(payload, current);
    assert.deepEqual(next, {
      model: current.id,
      tools: [...existing, { type: "web_search" }],
    });
    assert.deepEqual(payload.tools, existing);
  }
});

test("deduplicates existing web_search and web_search_preview on OpenAI", () => {
  const current = model("openai", "openai-responses", "gpt-6");
  assert.equal(
    injectServerTools({ tools: [{ type: "web_search" }] }, current),
    undefined,
  );
  assert.equal(
    injectServerTools({ tools: [{ type: "web_search_preview" }] }, current),
    undefined,
  );
});

test("injects googleSearch and urlContext into payload.config.tools for Google", () => {
  for (const current of [
    model("google", "google-generative-ai", "gemini-3-flash"),
    model("google-vertex", "google-vertex", "gemini-3-pro"),
  ]) {
    const existing = [{ functionDeclarations: [{ name: "read" }] }];
    const payload = { model: current.id, config: { tools: existing } };
    const next = injectServerTools(payload, current);
    assert.deepEqual(next, {
      model: current.id,
      config: {
        tools: [...existing, { googleSearch: {} }, { urlContext: {} }],
      },
    });
    assert.deepEqual(payload.config.tools, existing);
  }
});

test("deduplicates camelCase and snake_case Google tools", () => {
  const current = model("google", "google-generative-ai", "gemini-3-flash");
  assert.deepEqual(
    injectServerTools({ config: { tools: [{ google_search: {} }] } }, current),
    {
      config: {
        tools: [{ google_search: {} }, { urlContext: {} }],
      },
    },
  );
  assert.equal(
    injectServerTools(
      { config: { tools: [{ googleSearch: {} }, { url_context: {} }] } },
      current,
    ),
    undefined,
  );
});

test("injects protocol-specific server tools for DeepSeek models", () => {
  assert.deepEqual(
    injectServerTools(
      { tools: [] },
      model("deepseek", "openai-responses", "deepseek-v4-pro"),
    ),
    { tools: [{ type: "web_search" }] },
  );
  assert.deepEqual(
    injectServerTools(
      { tools: [] },
      model("deepseek", "openai-completions", "deepseek-flash"),
    ),
    {
      tools: [
        { type: "deepseek_web_search", name: "deepseek_web_search" },
        { type: "deepseek_read_url", name: "deepseek_read_url" },
      ],
    },
  );
  assert.equal(
    injectServerTools(
      { tools: [] },
      model("deepseek", "openai-completions", "deepseek-v4-pro"),
    ),
    undefined,
  );
});

test("passes through unsupported providers, APIs, and missing models unchanged", () => {
  assert.equal(
    injectServerTools(
      { tools: [] },
      model("anthropic", "anthropic-messages", "claude"),
    ),
    undefined,
  );
  assert.equal(
    injectServerTools(
      { tools: [] },
      model("xai", "openai-responses", "grok-4"),
    ),
    undefined,
  );
  assert.equal(
    injectServerTools(
      { tools: [] },
      model("openai", "openai-completions", "gpt-4o"),
    ),
    undefined,
  );
  assert.equal(injectServerTools({ tools: [] }, undefined), undefined);
  assert.equal(
    injectServerTools(null, model("openai", "openai-responses", "gpt-6")),
    undefined,
  );
});

test("extension registers only before_provider_request and forwards payload transformation", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  serverTools({
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);

  assert.deepEqual([...handlers.keys()], ["before_provider_request"]);
  const handler = handlers.get("before_provider_request");
  assert.ok(handler);
  assert.deepEqual(
    handler(
      { payload: { tools: [] } },
      { model: model("openai-codex", "openai-codex-responses", "gpt-6-luna") },
    ),
    { tools: [{ type: "web_search" }] },
  );
});
