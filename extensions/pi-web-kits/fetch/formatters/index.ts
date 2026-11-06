import { extname } from "node:path";
import { Worker } from "node:worker_threads";

export interface FormatDocumentInput {
  text: string;
  contentType?: string;
  filePath?: string;
  signal?: AbortSignal;
}

type Parser = "html" | "json" | "markdown";

const FILE_PARSERS: Readonly<Record<string, Parser>> = {
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

function selectParser(input: FormatDocumentInput): Parser | undefined {
  const mime = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/json" || mime?.endsWith("+json")) return "json";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  // A specific MIME takes precedence over a possibly misleading filename.
  if (mime && mime !== "text/plain") return undefined;
  if (input.filePath) {
    const parser = FILE_PARSERS[extname(input.filePath).toLowerCase()];
    if (parser) return parser;
  }
  if (
    !mime &&
    /<!doctype\s+html|<(?:html|head|body|title|p)\b/i.test(input.text)
  ) {
    return "html";
  }
  return undefined;
}

/** Fixed resource budgets; syntax errors, budget exhaustion and cancellation preserve input. */
export async function formatDocument(
  input: FormatDocumentInput,
): Promise<string> {
  const parser = selectParser(input);
  if (!parser || input.signal?.aborted) return input.text;
  return new Promise<string>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./prettier-worker.mjs", import.meta.url), {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
        // Do not inherit CLI/tsx loader flags into this plain ESM worker.
        execArgv: [],
      });
    } catch {
      resolve(input.text);
      return;
    }
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => {});
      resolve(text);
    };
    const onAbort = () => finish(input.text);
    const timer = setTimeout(onAbort, 5_000);
    worker.once("message", (text: unknown) => {
      finish(typeof text === "string" ? text : input.text);
    });
    worker.once("error", onAbort);
    worker.once("exit", onAbort);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    else {
      try {
        worker.postMessage({ text: input.text, parser });
      } catch {
        onAbort();
      }
    }
  });
}
