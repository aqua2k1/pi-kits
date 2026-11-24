import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  getMarkdownTheme,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Image,
  Markdown,
  Text,
} from "@earendil-works/pi-tui";
import { type ImageArtifact, isImageArtifact } from "./images.ts";

// CustomMessage is not exported by coding-agent's public entry point.
type CustomMessage<T> = Parameters<MessageRenderer<T>>[0];

export function renderImage(
  message: CustomMessage<ImageArtifact>,
  options: MessageRenderOptions,
  theme: Theme,
): Component {
  const container = new Container();
  const artifact = message.details;
  const dim = (text: string) => theme.fg("dim", text);
  if (!isImageArtifact(artifact)) {
    container.addChild(new Text("图片信息不可用", options.outputPad, 0, dim));
    return container;
  }
  // Escape Markdown syntax and control characters in the persisted path.
  const path = artifact.path
    // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize terminal control characters
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[\\`*_{}[\]()<>!#+.\-|]/g, "\\$&");
  container.addChild(
    new Markdown(path, options.outputPad, 0, getMarkdownTheme()),
  );
  try {
    const bytes = readFileSync(artifact.path);
    container.addChild(
      new Image(
        bytes.toString("base64"),
        artifact.mimeType,
        {
          fallbackColor: dim,
        },
        {
          filename: basename(artifact.path),
          maxWidthCells: 80,
          maxHeightCells: 24,
        },
      ),
    );
  } catch {
    container.addChild(new Text("图片无法读取", options.outputPad, 0, dim));
  }
  return container;
}
