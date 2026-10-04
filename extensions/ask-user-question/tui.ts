import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DockedPanelLifecycle } from "../../shared/ui/docked-panel/events.ts";
import { runDockedPanel } from "../../shared/ui/docked-panel/session.ts";
import type { AskUserParams, AskUserResult } from "./core.ts";
import { TabbedQuestionnaire } from "./ui/component.ts";

/** Questionnaire adapter; shared session owns host completion and abort cleanup. */
export function askTabbedQuestions(
  ui: Pick<ExtensionUIContext, "custom">,
  params: AskUserParams,
  signal?: AbortSignal,
  lifecycle?: DockedPanelLifecycle,
): Promise<AskUserResult> {
  return runDockedPanel<AskUserResult>(
    ui,
    (tui, theme, keys, done) =>
      new TabbedQuestionnaire(tui, theme, keys, params, done),
    { signal, lifecycle, isCancelled: (result) => result.cancelled },
  );
}
