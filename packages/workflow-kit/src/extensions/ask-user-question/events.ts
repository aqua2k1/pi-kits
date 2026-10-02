import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskUserResult } from "./core.ts";

export const ASK_USER_QUESTION_START = "workflow:ask-user-question:start";
export const ASK_USER_QUESTION_END = "workflow:ask-user-question:end";

export interface AskUserQuestionStartEvent {
  toolCallId: string;
  mode: ExtensionContext["mode"];
  questionCount: number;
}

export type AskUserQuestionEndEvent = AskUserQuestionStartEvent &
  (
    | { status: "answered" | "cancelled"; result: AskUserResult }
    | { status: "aborted" | "error" }
  );
