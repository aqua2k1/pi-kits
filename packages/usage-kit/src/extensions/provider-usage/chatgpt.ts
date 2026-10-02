/**
 * ChatGPT plan usage source (openai-codex provider).
 *
 * Same endpoint as the codex CLI: GET https://chatgpt.com/backend-api/wham/usage
 * with the ChatGPT account JWT (`Authorization: Bearer` + `ChatGPT-Account-Id`
 * decoded from the token). Windows are labeled like codex (±5% tolerance on
 * window seconds): 5h / daily / weekly / monthly / annual.
 *
 * Warning example: any window ≥ 80% used → yellow.
 */

import { HttpError, type WidgetSource } from "./source.js";

const CHATGPT_PROVIDER = "openai-codex";
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_PLACEHOLDER = "ChatGPT: --";
const CHATGPT_JWT_CLAIM_PATH = "https://api.openai.com/auth";
/** 预警阈值：任一窗口使用率 ≥ 该值时黄色显示 */
const WARNING_PERCENT = 80;

type WhamWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: number;
};

type WhamResponse = {
  plan_type?: string;
  rate_limit?: Record<string, unknown> | null;
};

function decodeAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    const id = payload?.[CHATGPT_JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** codex 同款窗口标签：按窗口秒数 ±5% 容差匹配 */
function windowLabel(seconds: number): string {
  const minutes = seconds / 60;
  const approx = (expected: number) =>
    minutes >= expected * 0.95 && minutes <= expected * 1.05;
  if (approx(5 * 60)) return "5h";
  if (approx(24 * 60)) return "daily";
  if (approx(7 * 24 * 60)) return "weekly";
  if (approx(30 * 24 * 60)) return "monthly";
  if (approx(365 * 24 * 60)) return "annual";
  return "limit";
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const DAY_WINDOW_SECONDS = 24 * 60 * 60;

/** 按窗口类型固定显示两个单位，保留 0 值（如 0h31m、0d1h）。 */
function formatReset(resetAtSec: number, windowSeconds: number): string {
  const minutes = Math.round((resetAtSec * 1000 - Date.now()) / 60_000);
  if (minutes <= 0) return "";

  if (windowSeconds >= DAY_WINDOW_SECONDS) {
    const days = Math.floor(minutes / MINUTES_PER_DAY);
    const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
    return `${days}d${hours}h`;
  }

  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${hours}h${minutes % MINUTES_PER_HOUR}m`;
}

function isWhamWindow(value: unknown): value is WhamWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.used_percent === "number" &&
    typeof window.limit_window_seconds === "number" &&
    typeof window.reset_at === "number"
  );
}

export const chatgptSource: WidgetSource = {
  provider: CHATGPT_PROVIDER,
  aliases: ["openai"],
  placeholder: CHATGPT_PLACEHOLDER,
  async fetch(apiKey, signal) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Originator: "pi",
      "User-Agent": "pi",
    };
    const accountId = decodeAccountId(apiKey);
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetch(CHATGPT_USAGE_URL, {
      method: "GET",
      headers,
      signal,
    });
    if (!res.ok) throw new HttpError(res.status);

    const data = (await res.json()) as WhamResponse | null;
    const rateLimit = data?.rate_limit;
    const windows = [
      rateLimit?.primary_window,
      rateLimit?.secondary_window,
      ...Object.entries(rateLimit ?? {})
        .filter(
          ([name]) => name !== "primary_window" && name !== "secondary_window",
        )
        .map(([, value]) => value),
    ]
      // 只保留窗口对象，兼容响应中出现的额外窗口（如 monthly_window）。
      .filter(isWhamWindow)
      .map((w) => ({
        label: windowLabel(w.limit_window_seconds),
        percent: w.used_percent,
        reset: formatReset(w.reset_at, w.limit_window_seconds),
      }));
    if (windows.length === 0) return undefined;

    const usage = windows.map((w) => `${w.label}: ${w.percent}%`).join(" · ");
    // 显示计划类型（free/plus...），缺失时省略前缀。
    const plan = data?.plan_type?.trim() || undefined;
    const prefix = plan ? `ChatGPT ${plan}` : "ChatGPT";
    const resets = windows
      .map((w) => w.reset)
      .filter(Boolean)
      .join("/");
    const line = [prefix, usage, resets ? `resets in ${resets}` : ""]
      .filter(Boolean)
      .join(" · ");
    return { line, windows };
  },
  // 具体示例：任一窗口使用率 ≥ 80% 进入预警状态（黄色显示）。
  isWarning: (data) => data.windows.some((w) => w.percent >= WARNING_PERCENT),
};
