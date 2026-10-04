import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot } from "./manager.ts";
import { agentDisplayStatus, oneLine } from "./presentation.ts";

function jsonText(value: unknown): string {
  return (JSON.stringify(value, null, 2) ?? "").replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Only the TUI presentation changes; tool content/details remain intact. */
export function subagentCallRenderer(
  label: string,
): NonNullable<ToolDefinition["renderCall"]> {
  return (args, theme, context) => {
    if (context.expanded) {
      return new Text(`${label}\n${jsonText(args)}`, 0, 0);
    }
    const values = args as Record<string, unknown>;
    const description =
      values && typeof values.description === "string"
        ? oneLine(values.description)
        : "";
    const title = theme.fg("toolTitle", theme.bold(label));
    const line = description ? `${title} · ${description}` : title;
    return {
      render: (width) => (width > 0 ? [truncateToWidth(line, width)] : []),
      invalidate() {},
    };
  };
}

export const renderSubagentResult: NonNullable<
  ToolDefinition["renderResult"]
> = (result, options, theme, context) => {
  if (options.expanded) {
    // Serialized JSON escapes controls in snapshot values and retains all metadata.
    const text = result.details
      ? jsonText(result.details)
      : result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text.split("\n").map(oneLine).join("\n"))
          .join("\n");
    return new Text(text, 0, 0);
  }
  const snapshot = result.details as AgentSnapshot | undefined;
  const valid =
    snapshot &&
    typeof snapshot.description === "string" &&
    typeof snapshot.status === "string";
  const failed =
    context.isError ||
    snapshot?.status === "error" ||
    snapshot?.status === "disconnected" ||
    snapshot?.sessionState === "disconnected";
  const status = valid
    ? agentDisplayStatus(snapshot)
    : failed
      ? "error"
      : "result";
  const args = context.args as Record<string, unknown> | undefined;
  const repeated = valid && args?.description === snapshot.description;
  const title =
    valid && !repeated
      ? `${oneLine(snapshot.description)} · ${oneLine(status)}`
      : oneLine(status);
  const preview = valid
    ? snapshot.error || snapshot.result || ""
    : result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(" ");
  const lines = [theme.fg(failed ? "error" : "muted", title)];
  if (preview.trim()) lines.push(oneLine(preview));
  if (snapshot?.truncated) lines.push(theme.fg("dim", "[Result truncated]"));
  return {
    render: (width) =>
      width > 0 ? lines.map((line) => truncateToWidth(line, width)) : [],
    invalidate() {},
  };
};
