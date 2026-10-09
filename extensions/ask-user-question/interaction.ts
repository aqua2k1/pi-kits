import type { UIHost, UIHostOutcome } from "@pi-kits/shared/ui/host";
import { createQuestionnaireController } from "./controller.ts";
import type { AskUserParams, AskUserResult } from "./core.ts";

export interface QuestionnaireLifecycle {
  onClosed?(outcome: UIHostOutcome): void | Promise<void>;
}

/** Run the business workflow through a frontend-neutral host, awaiting cleanup. */
export async function askQuestions(
  host: UIHost,
  params: AskUserParams,
  signal?: AbortSignal,
  viewId = "ask-user-question",
  lifecycle: QuestionnaireLifecycle = {},
): Promise<AskUserResult> {
  const controller = createQuestionnaireController(params, viewId);
  let result: AskUserResult | undefined;
  const session = host.open(controller.getView(), {
    signal,
    onClosed: lifecycle.onClosed,
    onEvent(event, current) {
      const transition = controller.handle(event);
      if (transition.result) {
        result = transition.result;
        current.close(result.cancelled ? "dismissed" : "completed");
      } else if (transition.view) {
        current.publish(transition.view);
      }
    },
  });
  const outcome = await session.closed;
  if ("error" in outcome) throw outcome.error;
  if (outcome.status === "aborted") {
    throw new DOMException("Questionnaire aborted.", "AbortError");
  }
  if (!result) throw new Error("Questionnaire closed without a result.");
  return result;
}
