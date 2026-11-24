import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  extractImageItems,
  type ImageArtifact,
  isImageArtifact,
  saveImage,
} from "./images.ts";
import { renderImage } from "./render.ts";

const MESSAGE_TYPE = "pi-image";
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function supports(
  model: { provider: string; api: string } | undefined,
): boolean {
  return (
    !!model &&
    ((model.provider === "openai" && model.api === "openai-responses") ||
      (model.provider === "openai-codex" &&
        model.api === "openai-codex-responses"))
  );
}
export function branchImages(ctx: ExtensionContext): ImageArtifact[] {
  return ctx.sessionManager.getBranch().flatMap((entry) => {
    if (
      entry.type !== "custom_message" ||
      entry.customType !== MESSAGE_TYPE ||
      !isImageArtifact(entry.details)
    )
      return [];
    return [entry.details];
  });
}
export default function imageExtension(pi: ExtensionAPI): void {
  let responseId: string | undefined;
  const seen = new Set<string>();
  let pending: { image: ImageArtifact; instruction: string } | undefined;
  const reset = () => {
    responseId = undefined;
    seen.clear();
    pending = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_settled", () => {
    pending = undefined;
  });
  pi.registerMessageRenderer<ImageArtifact>(MESSAGE_TYPE, renderImage);

  pi.on("provider_stream_event", async (event, ctx) => {
    if (
      !supports({
        provider: event.provider,
        api: event.api,
      })
    )
      return;
    const data = record(event.data);
    if (!data) return;
    const response = record(data.response);
    if (data.type === "response.created") {
      responseId = typeof response?.id === "string" ? response.id : undefined;
    }
    const id = typeof response?.id === "string" ? response.id : responseId;
    for (const item of extractImageItems(data)) {
      const key = `${event.provider}:${item.id}`;
      if (seen.has(key)) continue;
      try {
        if (!id) throw new Error("图片缺少所属 response ID");
        if (
          branchImages(ctx).some(
            (image) =>
              image.provider === event.provider && image.itemId === item.id,
          )
        ) {
          seen.add(key);
          continue;
        }
        const image = await saveImage(
          join(
            ctx.sessionManager.getSessionDir(),
            "images",
            ctx.sessionManager.getSessionId(),
          ),
          item,
          {
            provider: event.provider,
            api: event.api,
            model: event.model,
            responseId: id,
          },
        );
        seen.add(key);
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: `图片已保存：${image.path}`,
            display: true,
            details: image,
          },
          { triggerTurn: false },
        );
      } catch (error) {
        seen.add(key);
        pi.sendMessage(
          {
            customType: "pi-image-error",
            content: `图片保存失败：${error instanceof Error ? error.message : String(error)}`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }
  });

  pi.registerCommand("image-edit", {
    description: "选择当前分支的图片并编辑：/image-edit <修改要求>",
    handler: async (args, ctx) => {
      const instruction = args.trim();
      if (!instruction) {
        ctx.ui.notify("用法：/image-edit <修改要求>", "warning");
        return;
      }
      if (!ctx.isIdle() || pending) {
        ctx.ui.notify("请等待当前任务完成", "warning");
        return;
      }
      if (!supports(ctx.model)) {
        ctx.ui.notify("图片编辑需要 OpenAI / Codex Responses 模型", "error");
        return;
      }
      const images = branchImages(ctx).filter(
        (image) =>
          image.provider === ctx.model?.provider &&
          image.api === ctx.model?.api &&
          image.model === ctx.model?.id,
      );
      if (!images.length) {
        ctx.ui.notify("当前分支没有与当前模型匹配的图片", "warning");
        return;
      }
      let image = images[images.length - 1];
      if (images.length > 1) {
        if (!ctx.hasUI) {
          ctx.ui.notify("多张图片需要在交互模式中选择", "warning");
          return;
        }
        const labels = images.map(
          (image, index) => `${index + 1}. ${image.path}`,
        );
        const selected = await ctx.ui.select("选择要编辑的图片", labels);
        if (!selected) return;
        image = images[labels.indexOf(selected)];
      }
      pending = { image, instruction };
      try {
        pi.sendUserMessage(instruction);
      } catch (error) {
        pending = undefined;
        throw error;
      }
    },
  });
  pi.on("before_provider_request", (event) => {
    if (!pending) return;
    const payload = record(event.payload);
    if (!payload) return;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const existing = tools.find(
      (tool) => record(tool)?.type === "image_generation",
    );
    return {
      ...payload,
      previous_response_id: pending.image.responseId,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: pending.instruction }],
        },
      ],
      tools: [
        ...tools.filter((tool) => record(tool)?.type !== "image_generation"),
        { ...record(existing), type: "image_generation", action: "edit" },
      ],
      tool_choice: { type: "image_generation" },
    };
  });
}
