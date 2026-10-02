import { stripVTControlCharacters } from "node:util";
import {
  MAX_FETCH_CONTENT_BYTES,
  MAX_GITHUB_README_BYTES,
} from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import { limitUtf8Text } from "./spool.ts";

const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/"];
const BINARY_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/vnd.rar",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const NOSCRIPT_BLOCK = /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi;
const TEMPLATE_BLOCK = /<template\b[^>]*>[\s\S]*?<\/template\s*>/gi;
const COMMENT_BLOCK = /<!--[\s\S]*?-->/g;
const BLOCK_CLOSE =
  /<\/(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|title|ul)>/gi;
const BREAK_TAG = /<br\s*\/?>/gi;
const ANY_TAG = /<[^>]*>/g;
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const NAMED_ENTITY = /&(?:amp|lt|gt|quot|apos|#39|nbsp);/gi;
const NUMERIC_ENTITY = /&#(?:x([0-9a-f]+)|(\d+));/gi;
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  "tif",
  "mp3",
  "mp4",
  "avi",
  "mov",
  "mkv",
  "flv",
  "wmv",
  "wav",
  "ogg",
  "webm",
  "flac",
  "aac",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "exe",
  "dll",
  "so",
  "dylib",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "sqlite",
  "db",
  "sqlite3",
  "pyc",
  "class",
  "jar",
  "war",
  "iso",
  "img",
  "dmg",
]);

export interface DecodedDocument {
  text: string;
  title?: string;
  contentType?: string;
  truncated?: boolean;
}

function mimeType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function charset(contentType: string): string | undefined {
  const match = contentType.match(
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
  );
  return (match?.[1] ?? match?.[2])?.trim();
}

export function isSupportedTextType(contentType: string): boolean {
  const mime = mimeType(contentType);
  if (!mime) return true;
  if (BINARY_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)))
    return false;
  if (BINARY_MIME_TYPES.has(mime)) return false;
  return (
    mime.startsWith("text/") ||
    mime === "application/xhtml+xml" ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/manifest+json"
  );
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const encoding = charset(contentType) ?? "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeEntities(text: string): string {
  const named = text.replace(NAMED_ENTITY, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
      case "&#39;":
        return "'";
      case "&nbsp;":
        return " ";
      default:
        return entity;
    }
  });
  return named.replace(
    NUMERIC_ENTITY,
    (_entity, hex: string, decimal: string) => {
      const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "�";
    },
  );
}

function removeControlCharacters(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      character === "\n" ||
      character === "\t" ||
      (code >= 0x20 && code !== 0x7f)
    ) {
      result += character;
    }
  }
  return result;
}

function normalizeText(text: string): string {
  return removeControlCharacters(stripVTControlCharacters(text))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html: string): string | undefined {
  const match = html.match(TITLE_TAG);
  if (!match?.[1]) return undefined;
  const title = normalizeText(decodeEntities(match[1].replace(ANY_TAG, " ")));
  return title || undefined;
}

export function htmlToText(html: string): string {
  const withoutNonContent = html
    .replace(COMMENT_BLOCK, "")
    .replace(SCRIPT_BLOCK, "")
    .replace(STYLE_BLOCK, "")
    .replace(NOSCRIPT_BLOCK, "")
    .replace(TEMPLATE_BLOCK, "");
  const withBreaks = withoutNonContent
    .replace(BLOCK_CLOSE, "\n")
    .replace(BREAK_TAG, "\n");
  return normalizeText(decodeEntities(withBreaks.replace(ANY_TAG, " ")));
}

export function decodeDocument(
  bytes: Uint8Array,
  contentType: string,
  raw: boolean,
): DecodedDocument {
  const mime = mimeType(contentType);
  if (!isSupportedTextType(contentType)) {
    throw new WebFetchError(
      "unsupported",
      "The requested content is not supported.",
    );
  }
  if (!contentType && bytes.includes(0)) {
    throw new WebFetchError(
      "unsupported",
      "The requested content is not supported.",
    );
  }
  const body = decodeBody(bytes, contentType);
  const looksLikeHtml =
    mime.includes("html") ||
    (!mime && /<!doctype\s+html|<(?:html|head|body|title|p)\b/i.test(body));
  if (raw || !looksLikeHtml) {
    const bounded = limitUtf8Text(body, MAX_FETCH_CONTENT_BYTES);
    return {
      text: bounded.text,
      contentType: contentType || undefined,
      truncated: bounded.truncated,
    };
  }
  const extracted = htmlToText(body);
  const bounded = limitUtf8Text(extracted, MAX_FETCH_CONTENT_BYTES);
  return {
    text: bounded.text,
    title: extractTitle(body),
    contentType: contentType || undefined,
    truncated: bounded.truncated,
  };
}

export function limitReadme(text: string): string {
  return limitUtf8Text(text, MAX_GITHUB_README_BYTES).text;
}

export function isBinaryFileName(filePath: string): boolean {
  const extension = filePath.toLowerCase().split(".").pop();
  return BINARY_EXTENSIONS.has(extension ?? "");
}
