/**
 * Provider usage/balance widget (below editor).
 *
 * Mutually exclusive — the active source is decided by the main session
 * model's provider:
 *   deepseek     → DeepSeek account balance (deepseek.ts)
 *   openai-codex → ChatGPT plan usage (chatgpt.ts, wham/usage like codex CLI)
 *
 * Polls every 10 minutes; `/usage` refreshes on demand. Warning state (yellow) is
 * abstracted per source via `isWarning(data)`; concrete example: ChatGPT turns
 * yellow when any usage window reaches ≥ 80%.
 *
 * Display:
 *   success:   DeepSeek: 110.00 CNY
 *              ChatGPT free · monthly: 0% · resets in 29d
 *   stale:     <success> (stale)
 *   placeholder / unavailable / empty / error-without-cache: source placeholder (+ error reason)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readPiKitsConfig } from "@pi-kits/config";
import { chatgptSource } from "./chatgpt.js";
import { deepseekSource } from "./deepseek.js";
import {
  HttpError,
  type Registry,
  type Ui,
  type UsageData,
  WIDGET_ID,
  type WidgetSource,
} from "./source.js";

const sources: WidgetSource[] = [deepseekSource, chatgptSource];

// ---------------------------------------------------------------------------
// Dispatcher：单 widget、互斥，跟随主会话模型 provider
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const { usage } = readPiKitsConfig();
  if (!usage.enabled || !usage.providerUsage.enabled) return;
  const { intervalMs, timeoutMs } = usage.providerUsage;

  let ui: Ui | null = null;
  let registry: Registry | null = null;
  let active = false;
  let source: WidgetSource | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let abort: AbortController | null = null;
  let fetchGen = 0;
  /** 各 source 最近一次成功的 UsageData（不含占位/stale）。 */
  const caches = new Map<string, UsageData>();
  /** 当前渲染快照（不含主题）；factory 渲染时重读。 */
  let display: { line: string; isWarning: boolean } | null = null;

  function setLine(data: UsageData | undefined) {
    if (!ui) return;
    if (!data || !source) {
      display = null;
      ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    const isWarning = source.isWarning(data);
    display = { line: data.line, isWarning };
    // dim 与 footer token/cost 同色调；warning 为黄色预警。
    ui.setWidget(
      WIDGET_ID,
      (_tui, theme) =>
        new Text(
          theme.fg(isWarning ? "warning" : "dim", display?.line ?? ""),
          0,
          0,
        ),
      { placement: "belowEditor" },
    );
  }

  function showFailure(err?: unknown) {
    if (!active || !source) return;
    const cache = caches.get(source.provider);
    if (cache) {
      setLine({ ...cache, line: `${cache.line} (stale)` });
      return;
    }
    // 无缓存时带错误简因，便于定位（timeout / HTTP 403 / TypeError: fetch failed 等）。
    const reason =
      err instanceof HttpError
        ? `HTTP ${err.status}`
        : err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError")
          ? "timeout"
          : err instanceof Error
            ? `${err.name}: ${err.message}`.slice(0, 40)
            : "error";
    setLine({ line: `${source.placeholder} (${reason})`, windows: [] });
  }

  function stop() {
    active = false;
    source = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (abort) {
      abort.abort();
      abort = null;
    }
    fetchGen++;
    setLine(undefined);
  }

  async function refresh() {
    if (!active || !ui || !registry || !source) return;

    // Authentication is asynchronous too: snapshot identity and invalidate the
    // previous refresh before awaiting credentials, not just before fetching.
    const currentSource = source;
    const currentRegistry = registry;
    if (abort) abort.abort();
    const controller = new AbortController();
    abort = controller;
    const gen = ++fetchGen;
    const isCurrent = () =>
      active &&
      source === currentSource &&
      registry === currentRegistry &&
      gen === fetchGen;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const apiKey = await currentRegistry.getApiKeyForProvider(
        currentSource.provider,
      );
      if (!isCurrent() || controller.signal.aborted) return;
      if (!apiKey) {
        // 无认证：隐藏并停止轮询。过时的认证结果不能停止新 source。
        stop();
        return;
      }

      // 首次加载 / 无缓存：先显示占位。
      if (!caches.has(currentSource.provider))
        setLine({ line: currentSource.placeholder, windows: [] });

      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const data = await currentSource.fetch(apiKey, controller.signal);
      if (!isCurrent()) return;

      if (data === undefined) {
        // 无数据 → 占位；不覆盖缓存。
        setLine({ line: currentSource.placeholder, windows: [] });
        return;
      }

      caches.set(currentSource.provider, data);
      setLine(data);
    } catch (err) {
      // Abort on switch-away/shutdown is ignored via identity/generation checks.
      if (!isCurrent()) return;
      // 401 = token 失效，缓存无意义：给出可操作的提示。
      if (
        err instanceof HttpError &&
        err.status === 401 &&
        currentSource.authFailureMessage
      ) {
        caches.delete(currentSource.provider);
        setLine({
          line: currentSource.authFailureMessage,
          windows: [],
        });
        return;
      }
      showFailure(err);
    } finally {
      clearTimeout(timeout);
      if (abort === controller) abort = null;
    }
  }

  function start(ctx: ExtensionContext) {
    ui = ctx.ui;
    registry = ctx.modelRegistry;
    active = true;
    // Re-entry with cache: show it immediately while refresh is in flight.
    const cache = source ? caches.get(source.provider) : undefined;
    if (cache) setLine(cache);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    void refresh();
  }

  function bindCtx(ctx: ExtensionContext) {
    ui = ctx.ui;
    registry = ctx.modelRegistry;
  }

  function sourceFor(
    model: { provider?: string } | undefined | null,
  ): WidgetSource | undefined {
    const provider = model?.provider;
    if (provider === undefined) return undefined;
    return sources.find((s) => s.provider === provider);
  }

  // 未实现的 provider：无事发生（不刷新、不提示）。
  pi.registerCommand("usage", {
    description: "Refresh provider usage/balance widget now",
    handler: async (_args, ctx) => {
      if (!active || !source) return;
      await refresh();
      // 通知最新渲染行（成功 / stale / 错误均如实反馈）。
      if (active && display)
        ctx.ui.notify(display.line, display.isWarning ? "warning" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    bindCtx(ctx);
    const s = sourceFor(ctx.model);
    if (s) {
      source = s;
      start(ctx);
    } else {
      stop();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    bindCtx(ctx);
    const s = sourceFor(event.model);
    if (s) {
      source = s;
      start(ctx);
    } else {
      stop();
    }
  });

  pi.on("session_shutdown", async () => {
    stop();
    ui = null;
    registry = null;
  });
}
