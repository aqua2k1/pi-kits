import { stripVTControlCharacters } from "node:util";
import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../core/types.ts";

const REDACTED = "[redacted]";
const SENSITIVE_NAME =
  /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|key|secret|password|credential|authorization|auth|signature|hmac|sig|policy|x-amz-[\w-]+|x-goog-[\w-]+)$/i;
const URL_IN_TEXT =
  /https?(?::\/\/|%(?:25)*3a%(?:25)*2f%(?:25)*2f)[^\s<>"'`)\]]+/gi;
const MAX_ENCODING_DEPTH = 4;
const MAX_URL_BYTES = 2_048;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return "";
}

function decode(value: string): string {
  for (let i = 0; i < MAX_ENCODING_DEPTH; i++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
}

/** Request-local only: exact credentials first, token patterns as defense in depth. */
export function createRedactor(
  secrets: readonly string[] = [],
): (text: string) => string {
  const variants = new Set<string>();
  for (const secret of secrets.filter(Boolean)) {
    const bytes = Buffer.from(secret);
    let encoded = secret;
    let percent = [...bytes]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    variants.add(secret);
    variants.add(bytes.toString("base64"));
    variants.add(bytes.toString("base64url"));
    for (let depth = 0; depth < MAX_ENCODING_DEPTH; depth++) {
      encoded = encodeURIComponent(encoded);
      variants.add(encoded);
      variants.add(percent);
      percent = encodeURIComponent(percent);
    }
  }
  const exact = variants.size
    ? new RegExp(
        [...variants]
          .sort((a, b) => b.length - a.length)
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "gi",
      )
    : undefined;
  return (text) => {
    const redacted = exact ? text.replace(exact, REDACTED) : text;
    return redacted
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        REDACTED,
      )
      .replace(
        /\b((?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|authorization|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&<>"'`)\]]+)/gi,
        `$1${REDACTED}`,
      );
  };
}

/** Reject userinfo; remove sensitive query values and all fragments before reuse as text. */
function isSensitiveName(value: string): boolean {
  return SENSITIVE_NAME.test(decode(value));
}

function safeUrl(
  raw: string,
  redact: (text: string) => string,
): string | undefined {
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    url.hash = "";
    const segments = url.pathname.split("/");
    let sensitivePath = false;
    url.pathname = segments
      .map((segment) => {
        const decoded = decode(segment);
        const clean = redact(decoded);
        if (sensitivePath || clean !== decoded || /%[a-f0-9]{2}/i.test(decoded))
          return REDACTED;
        sensitivePath = isSensitiveName(decoded);
        return segment;
      })
      .join("/");
    for (const [key, value] of [...url.searchParams]) {
      if (isSensitiveName(key) || /%[a-f0-9]{2}/i.test(decode(key))) {
        url.searchParams.delete(key);
        continue;
      }
      const decoded = decode(value);
      // Nested URLs can themselves contain credentials. Do not expose redirect payloads.
      const clean = /https?:\/\/|%[a-f0-9]{2}/i.test(decoded)
        ? REDACTED
        : redact(decoded);
      if (clean !== decoded) url.searchParams.set(key, clean);
    }
    // Redaction in an authority/scheme can make a URL invalid; omit it rather than
    // letting downstream URL parsing fail or fall back to the original text.
    return new URL(redact(url.toString())).toString();
  } catch {
    return undefined;
  }
}

function safeText(text: string, redact: (text: string) => string): string {
  // URL parsing must precede generic key=value redaction (which can break URLs).
  const plain = stripVTControlCharacters(text)
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "");
  const urls = plain.replace(
    URL_IN_TEXT,
    (url) =>
      safeUrl(/^https?:\/\//i.test(url) ? url : decode(url), redact) ??
      "[redacted URL]",
  );
  return redact(urls).replace(/\s+/g, " ").trim();
}

function withinDomains(
  url: string,
  domains: readonly string[] | undefined,
): boolean {
  if (!domains?.length) return true;
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => {
    const normalized = domain.toLowerCase();
    const suffix = normalized.replace(/^\*\./, "");
    return (
      hostname.endsWith(`.${suffix}`) ||
      (normalized === suffix && hostname === suffix)
    );
  });
}

function resultKey(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_|^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
      parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

/** Both adapters share one output policy; wire-shape parsing stays with the adapter. */
export function normalizeSearchResponse(
  request: SearchRequest,
  candidates: Iterable<SearchResult>,
  summary?: string,
  secrets: readonly string[] = [],
): SearchResponse {
  const redact = createRedactor(secrets);
  let truncated = false;
  const text = (raw: string, maxBytes: number) => {
    const clean = safeText(raw, redact);
    if (Buffer.byteLength(clean) <= maxBytes) return clean;
    truncated = true;
    let end = maxBytes - 3;
    const bytes = Buffer.from(clean);
    while ((bytes[end] & 0xc0) === 0x80) end--;
    return `${bytes.subarray(0, end).toString("utf8")}…`;
  };
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const url = safeUrl(candidate.url, redact);
    if (!url || !withinDomains(url, request.domains)) continue;
    if (Buffer.byteLength(url) > MAX_URL_BYTES) {
      truncated = true;
      continue;
    }
    const key = resultKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title: text(candidate.title || url, 500),
      url,
      snippet: text(candidate.snippet, 2_000),
    });
    if (results.length >= request.maxResults) break;
  }
  const query = text(request.query, 2_000);
  const safeSummary = summary ? text(summary, 4_000) : undefined;
  return {
    query,
    results,
    ...(safeSummary ? { summary: safeSummary } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}
