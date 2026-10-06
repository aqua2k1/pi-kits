import { type KeybindingsManager, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionnaireAction } from "./state.ts";

export function questionnaireKeyAction(
  data: string,
  keybindings?: Pick<KeybindingsManager, "matches">,
): QuestionnaireAction | undefined {
  if (matchesKey(data, "tab")) {
    return { type: "switch", delta: 1 };
  }
  if (matchesKey(data, "shift+tab")) {
    return { type: "switch", delta: -1 };
  }
  if (
    matchesKey(data, "escape") ||
    matchesKey(data, "ctrl+c") ||
    keybindings?.matches(data, "tui.select.cancel")
  ) {
    return { type: "cancel" };
  }
  if (
    matchesKey(data, "enter") ||
    keybindings?.matches(data, "tui.select.confirm")
  ) {
    return { type: "confirm" };
  }
  if (matchesKey(data, "space")) return { type: "toggle" };
  if (matchesKey(data, "up") || keybindings?.matches(data, "tui.select.up")) {
    return { type: "move", delta: -1 };
  }
  if (
    matchesKey(data, "down") ||
    keybindings?.matches(data, "tui.select.down")
  ) {
    return { type: "move", delta: 1 };
  }
  return undefined;
}
