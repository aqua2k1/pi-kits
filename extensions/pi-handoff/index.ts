import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const HANDOFF_INSTRUCTIONS = `Prepare a concise handoff summary for the next agent.
Preserve the goal, constraints, progress, key decisions, blockers, next steps, read files, and modified files.
Do not reproduce the full transcript or diff. Redact secrets.`;

function compactForHandoff(
  ctx: ExtensionCommandContext,
  focus: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      customInstructions: focus
        ? `${HANDOFF_INSTRUCTIONS}\nUser focus: ${focus}`
        : HANDOFF_INSTRUCTIONS,
      onComplete: () => resolve(),
      onError: reject,
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Clone the current session and compact it for handoff",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const leafId = ctx.sessionManager.getLeafId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!leafId || !sessionFile) {
        ctx.ui.notify("Cannot handoff an empty or unsaved session", "warning");
        return;
      }

      await ctx.fork(leafId, {
        position: "at",
        withSession: async (nextCtx) => {
          await compactForHandoff(nextCtx, args.trim());
          nextCtx.ui.notify(
            `Handoff session ready:\n${nextCtx.sessionManager.getSessionFile() ?? "(memory session)"}`,
            "info",
          );
        },
      });
    },
  });
}
