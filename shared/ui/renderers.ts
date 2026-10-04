import type {
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
export type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
export interface RenderSummary {
  title?: string;
  status: string;
  preview?: string;
  isError?: boolean;
  truncated?: boolean;
}

export function oneLine(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
}

export function jsonText(value: unknown): string {
  return (JSON.stringify(value, null, 2) ?? "").replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textContent(
  content: Parameters<ResultRenderer>[0]["content"],
): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function expandedResult(content: string, details: unknown): Text {
  const metadata = details === undefined ? "" : jsonText(details);
  const body =
    details !== undefined && content === JSON.stringify(details, null, 2)
      ? ""
      : stripTerminalSequences(content).replace(
          /[\p{Cc}\p{Zl}\p{Zp}]/gu,
          (char) => (char === "\n" ? char : " "),
        );
  return new Text([body, metadata].filter(Boolean).join("\n\n"), 0, 0);
}

function linesComponent(lines: string[]) {
  return {
    render: (width: number) =>
      width > 0 ? lines.map((line) => truncateToWidth(line, width)) : [],
    invalidate() {},
  };
}

function summaryComponent(
  summary: RenderSummary,
  theme: Theme,
  label?: string,
) {
  const title = [label, summary.title, summary.status]
    .filter((value): value is string => Boolean(value))
    .map(oneLine)
    .join(" · ");
  const lines = [theme.fg(summary.isError ? "error" : "muted", title)];
  if (summary.preview?.trim())
    lines.push(oneLine(summary.preview.slice(0, 1024)));
  if (summary.truncated) lines.push(theme.fg("dim", "[Result truncated]"));
  return linesComponent(lines);
}

/** Presentation only. Extensions supply summaries and retain ownership of their data. */
export function compactCall(
  label: string,
  summarize: (args: unknown) => string = () => "",
): CallRenderer {
  return (args, theme, context) => {
    if (context.expanded) return new Text(`${label}\n${jsonText(args)}`, 0, 0);
    const title = theme.fg("toolTitle", theme.bold(label));
    const preview = oneLine(summarize(args).slice(0, 1024));
    return linesComponent([preview ? `${title} · ${preview}` : title]);
  };
}

export function compactResult(
  summarize: (details: unknown, args: unknown) => RenderSummary | undefined,
): ResultRenderer {
  return (result, options, theme, context) => {
    if (options.expanded)
      return expandedResult(textContent(result.content), result.details);
    if (context.isError)
      return summaryComponent(
        {
          status: "error",
          isError: true,
          preview: textContent(result.content),
        },
        theme,
      );
    const summary = summarize(result.details, context.args);
    if (options.isPartial && !summary)
      return summaryComponent(
        { status: "running", preview: textContent(result.content) },
        theme,
      );
    return summaryComponent(
      summary ?? { status: "result", preview: textContent(result.content) },
      theme,
    );
  };
}

export function compactMessage(
  label: string,
  summarize: (details: unknown) => RenderSummary | undefined,
): MessageRenderer {
  return (message, options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : textContent(message.content);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      options.expanded
        ? expandedResult(content, message.details)
        : summaryComponent(
            summarize(message.details) ?? {
              status: "result",
              preview: content,
            },
            theme,
            label,
          ),
    );
    return box;
  };
}
