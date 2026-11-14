import { open, unlink } from "node:fs/promises";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type RequestErrorCode =
  | "status"
  | "network"
  | "timeout"
  | "cancelled"
  | "invalid-response";

export class RequestError extends Error {
  constructor(
    readonly code: RequestErrorCode,
    readonly status?: number,
  ) {
    super(`Request failed: ${code}.`);
    this.name = "RequestError";
  }
}

/** A single deadline, including for I/O that ignores the supplied signal. */
export async function withRequestDeadline<T>(
  timeoutMs: number | undefined,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) throw abortError(parent);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortError(parent));
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new RequestError("timeout")),
          timeoutMs,
        );
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function abortError(signal?: AbortSignal): RequestError {
  return signal?.reason instanceof RequestError &&
    signal.reason.code === "timeout"
    ? signal.reason
    : new RequestError("cancelled");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

// Cancellation is best effort: neither rejection nor a hanging cancel blocks us.
function cancel(body: { cancel(): Promise<unknown> } | null | undefined): void {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    // Cleanup must not replace the original error.
  }
}

type ResponseMeta = { headers: Headers; finalUrl: string };
type RequestOptions = Pick<RequestInit, "method" | "headers" | "body"> & {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
  redirect: "error" | "follow";
  fetch?: FetchLike;
  validateResponse?: (meta: ResponseMeta) => void;
};
type FileResult = ResponseMeta & { bytes: number };

export function request(
  url: string | URL,
  options: RequestOptions & { response: "json" },
): Promise<unknown>;
export function request(
  url: string | URL,
  options: RequestOptions & { response: "file"; destination: string },
): Promise<FileResult>;
export function request(
  url: string | URL,
  options: RequestOptions &
    ({ response: "json" } | { response: "file"; destination: string }),
): Promise<unknown | FileResult> {
  return withRequestDeadline(
    options.timeoutMs,
    options.signal,
    async (signal) => {
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let complete = false;
      let validationFailed = false;
      const onAbort = () => cancel(reader ?? response?.body);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        checkAbort(signal);
        const pending = (options.fetch ?? fetch)(url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          redirect: options.redirect,
          signal,
        }).then((result) => {
          if (signal.aborted) {
            cancel(result.body);
            checkAbort(signal);
          }
          return result;
        });
        response = await withRequestDeadline(undefined, signal, () => pending);
        checkAbort(signal);
        if (!response.ok) throw new RequestError("status", response.status);
        if (options.redirect === "error" && response.redirected) {
          throw new RequestError("invalid-response");
        }
        const meta = {
          headers: response.headers,
          finalUrl: response.url || String(url),
        };
        try {
          options.validateResponse?.(meta);
        } catch (error) {
          validationFailed = true;
          throw error;
        }
        checkAbort(signal);
        if (options.response === "file") {
          const declared = response.headers.get("content-length");
          if (declared !== null && Number(declared) > options.maxBytes) {
            throw new RequestError("invalid-response");
          }
          file = await open(options.destination, "w", 0o600);
          checkAbort(signal);
        } else if (!response.body) {
          throw new RequestError("invalid-response");
        }
        reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (reader) {
          checkAbort(signal);
          const currentReader = reader;
          const { done, value } = await withRequestDeadline(
            undefined,
            signal,
            () => currentReader.read(),
          );
          checkAbort(signal);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > options.maxBytes) {
            throw new RequestError("invalid-response");
          }
          if (file) {
            let offset = 0;
            while (offset < value.byteLength) {
              checkAbort(signal);
              const { bytesWritten } = await file.write(
                value,
                offset,
                value.byteLength - offset,
              );
              if (bytesWritten <= 0) throw new RequestError("network");
              offset += bytesWritten;
            }
          } else {
            // Own the bytes even if an injected stream reuses its backing buffer.
            chunks.push(value.slice());
          }
        }
        checkAbort(signal);
        if (file) {
          await file.close();
          checkAbort(signal);
          complete = true;
          return { ...meta, bytes };
        }
        try {
          return JSON.parse(
            Buffer.concat(chunks, bytes).toString("utf8"),
          ) as unknown;
        } catch {
          throw new RequestError("invalid-response");
        }
      } catch (error) {
        if (validationFailed) throw error;
        if (signal.aborted) throw abortError(signal);
        throw error instanceof RequestError
          ? error
          : new RequestError("network");
      } finally {
        signal.removeEventListener("abort", onAbort);
        cancel(reader ?? response?.body);
        try {
          reader?.releaseLock();
        } catch {
          // A non-cooperating reader may still have a pending read.
        }
        if (file && !complete) {
          await file.close().catch(() => {});
          if (options.response === "file") {
            await unlink(options.destination).catch(() => {});
          }
        }
      }
    },
  );
}
