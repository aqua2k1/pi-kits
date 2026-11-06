import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FETCH_RESPONSE_SIZE_LIMIT_MESSAGE,
  MAX_FETCH_CONTENT_BYTES,
  TEMP_SPOOL_TTL_MS,
} from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";

const FETCH_TEMP_PREFIX = "pi-web-fetch-";
const RESPONSE_FILE = "response.bin";
const CONTENT_FILE = "content.txt";

export interface BoundedText {
  text: string;
  truncated: boolean;
  totalBytes: number;
  outputBytes: number;
}

export interface TempSpool {
  readonly directory: string;
  readonly responsePath: string;
  readonly contentPath: string;
  readonly bytes: number;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  saveText(text: string): Promise<BoundedText>;
  cleanup(): Promise<void>;
}

type TempSpoolState = "open" | "closed" | "finalizing" | "finalized";

function stateError(state: TempSpoolState): WebFetchError {
  if (state === "finalized" || state === "finalizing") {
    return new WebFetchError(
      "invalid-response",
      "The fetch response has already been finalized.",
    );
  }
  return new WebFetchError(
    "invalid-response",
    "The fetch response spool is closed.",
  );
}

async function writeFully(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk.subarray(offset));
    if (
      result.bytesWritten <= 0 ||
      result.bytesWritten > chunk.byteLength - offset
    ) {
      throw new WebFetchError(
        "invalid-response",
        "The fetch response could not be written completely.",
      );
    }
    offset += result.bytesWritten;
  }
}

export function limitUtf8Text(
  text: string,
  maxBytes = MAX_FETCH_CONTENT_BYTES,
): BoundedText {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return {
      text,
      truncated: false,
      totalBytes: encoded.byteLength,
      outputBytes: encoded.byteLength,
    };
  }

  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  const bounded = encoded.subarray(0, end).toString("utf8");
  return {
    text: bounded,
    truncated: true,
    totalBytes: encoded.byteLength,
    outputBytes: Buffer.byteLength(bounded, "utf8"),
  };
}

export async function createTempSpool(
  baseDir = tmpdir(),
  prefix = FETCH_TEMP_PREFIX,
): Promise<TempSpool> {
  const directory = await mkdtemp(join(baseDir, prefix));
  const responsePath = join(directory, RESPONSE_FILE);
  const contentPath = join(directory, CONTENT_FILE);
  await chmod(directory, 0o700);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(responsePath, "wx", 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let bytes = 0;
  let state: TempSpoolState = "open";
  let writes: Promise<void> = Promise.resolve();
  let handleClosePromise: Promise<void> | undefined;

  const closeHandle = (): Promise<void> => {
    handleClosePromise ??= handle.close();
    return handleClosePromise;
  };

  const drainAndClose = async () => {
    let failure: unknown;
    try {
      await writes;
    } catch (error) {
      failure = error;
    }
    try {
      await closeHandle();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  };

  const close = async () => {
    if (state === "open") state = "closed";
    await drainAndClose();
  };

  const cleanup = async () => {
    await close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  };

  return {
    directory,
    responsePath,
    contentPath,
    get bytes() {
      return bytes;
    },
    async write(chunk: Uint8Array) {
      if (state !== "open") throw stateError(state);
      if (bytes + chunk.byteLength > MAX_FETCH_CONTENT_BYTES) {
        throw new WebFetchError(
          "invalid-response",
          FETCH_RESPONSE_SIZE_LIMIT_MESSAGE,
        );
      }
      bytes += chunk.byteLength;
      writes = writes.then(() => writeFully(handle, chunk));
      await writes;
    },
    close,
    async saveText(text: string) {
      if (state === "finalized" || state === "finalizing") {
        throw stateError(state);
      }
      state = "finalizing";
      await close();
      const bounded = limitUtf8Text(text);
      await writeFile(contentPath, bounded.text, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rm(responsePath, { force: true });
      state = "finalized";
      return bounded;
    },
    cleanup,
  };
}

export async function cleanupExpiredSpools(
  baseDir = tmpdir(),
  now = Date.now(),
): Promise<void> {
  // Deliberately keep this best-effort: a missing or unreadable temp directory
  // must not prevent the extension from starting.
  const { readdir, stat } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(FETCH_TEMP_PREFIX))
      .map(async (entry) => {
        const path = join(baseDir, entry);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > TEMP_SPOOL_TTL_MS) {
            await rm(path, { recursive: true, force: true });
          }
        } catch {
          // Ignore races with another cleanup or the operating system.
        }
      }),
  );
}
