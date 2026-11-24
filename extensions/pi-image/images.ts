import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export interface ImageArtifact {
  provider: string;
  api: string;
  model: string;
  responseId: string;
  itemId: string;
  path: string;
  mimeType: string;
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractImageItems(
  data: unknown,
): Array<{ id: string; result: string }> {
  if (!record(data)) return [];
  const items =
    data.type === "response.output_item.done"
      ? [data.item]
      : data.type === "response.completed" &&
          record(data.response) &&
          Array.isArray(data.response.output)
        ? data.response.output
        : [];
  return items.flatMap((item) =>
    record(item) &&
    item.type === "image_generation_call" &&
    item.status === "completed" &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.result === "string" &&
    item.result.length > 0
      ? [{ id: item.id, result: item.result }]
      : [],
  );
}

export function isImageArtifact(value: unknown): value is ImageArtifact {
  return (
    record(value) &&
    ["provider", "api", "model", "responseId", "itemId", "path"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    ["image/png", "image/jpeg", "image/webp"].includes(value.mimeType as string)
  );
}

export function saveImage(
  dir: string,
  item: { id: string; result: string },
  source: Omit<ImageArtifact, "itemId" | "path" | "mimeType">,
): ImageArtifact {
  if (typeof item.id !== "string" || !item.id.length)
    throw new Error("Invalid image ID");
  const encoded = item.result;
  if (
    typeof encoded !== "string" ||
    !encoded.length ||
    encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error("Invalid image base64 or size");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded) {
    throw new Error("Invalid image base64 or size");
  }
  let extension: string;
  let mimeType: string;
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    extension = "png";
    mimeType = "image/png";
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    extension = "jpg";
    mimeType = "image/jpeg";
  } else if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    extension = "webp";
    mimeType = "image/webp";
  } else {
    throw new Error("Unsupported image signature");
  }
  const name = createHash("sha256").update(item.id).digest("hex");
  const path = resolve(dir, `${name}.${extension}`);
  const artifact = {
    provider: source.provider,
    api: source.api,
    model: source.model,
    responseId: source.responseId,
    itemId: item.id,
    path,
    mimeType,
  };
  if (!isImageArtifact(artifact)) throw new Error("Invalid image metadata");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!record(error) || error.code !== "EEXIST") throw error;
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size !== bytes.length ||
        !readFileSync(fd).equals(bytes)
      ) {
        throw new Error("Existing image differs");
      }
    } finally {
      closeSync(fd);
    }
  }
  return artifact;
}
