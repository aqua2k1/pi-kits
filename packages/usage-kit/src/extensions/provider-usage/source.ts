/**
 * Shared widget-source abstraction for the provider usage/balance widget.
 *
 * The widget is mutually exclusive: exactly one source is active at a time,
 * decided by the main session model's provider (see index.ts). Each source
 * knows how to fetch its data and whether it has reached a warning state
 * (rendered in yellow via `isWarning(data)`).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WIDGET_ID = "provider-usage";
// 轮询间隔 10 min；需要即时数据时用 /usage 主动刷新。
export const INTERVAL_MS = 60 * 10 * 1000;
// 代理路径实测单次请求 ~4.7s（EnvHttpProxyAgent 冷连接），5s 会稳定超时；15s 留足余量。
export const TIMEOUT_MS = 15 * 1000;

export type Ui = ExtensionContext["ui"];
export type Registry = ExtensionContext["modelRegistry"];

/** 一次拉取的结果：显示行 + 供 isWarning 判断的窗口数据 */
export type UsageData = {
  line: string;
  windows: { label: string; percent: number }[];
  /** 各币种余额金额（如 DeepSeek 余额），供 isWarning 判断 */
  amounts?: number[];
};

/** 每个 provider 一个数据源；widget 互斥，由主会话模型 provider 决定显示哪个 */
export interface WidgetSource {
  provider: string;
  /** 主会话模型 provider 的别名；认证和缓存仍使用 provider。 */
  aliases?: readonly string[];
  /** 首次加载 / 无数据时的占位行 */
  placeholder: string;
  fetch(apiKey: string, signal: AbortSignal): Promise<UsageData | undefined>;
  /** 达到预警状态 → 黄色显示（变色抽象，各 source 实现） */
  isWarning(data: UsageData): boolean;
}

export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}
