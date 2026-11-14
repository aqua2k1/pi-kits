import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  type FetchLike,
  RequestError,
  request,
  withRequestDeadline,
} from "./request.ts";

const url = "https://example.test/data";
const encode = (text: string) => new TextEncoder().encode(text);
const base = { maxBytes: 16, redirect: "error" as const };

function classified(code: RequestError["code"], status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  };
}

function tracked(chunks: Uint8Array[] = [], status = 200) {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      cancelled++;
    },
  });
  return {
    response: new Response(body, { status }),
    cancelled: () => cancelled,
  };
}

function json(response: Response, maxBytes = 16) {
  return request(url, {
    ...base,
    maxBytes,
    response: "json",
    fetch: async () => response,
  });
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("test hung")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  run: (destination: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "web-request-"));
  try {
    await run(join(directory, "body"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function missing(path: string) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("JSON accepts the exact byte limit, primitive values and split UTF-8", async () => {
  for (const payload of ['{"x":"é"}', "null", "false", "123", '""']) {
    const bytes = encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    assert.deepEqual(
      await json(new Response(stream), bytes.length),
      JSON.parse(payload),
    );
  }
});

test("JSON rejects empty/null bodies, malformed JSON and bytes over the limit", async () => {
  for (const body of [null, "", " ", "SECRET", "{", "{}{}"]) {
    await assert.rejects(
      json(new Response(body)),
      classified("invalid-response"),
    );
  }
  const stream = tracked([encode("{}"), encode(" ")]);
  stream.response.headers.set("content-length", "1");
  await assert.rejects(
    json(stream.response, 2),
    classified("invalid-response"),
  );
  assert.equal(stream.cancelled(), 1);
  assert.equal(stream.response.body?.locked, false);
});

test("status errors include only the status and cancel the unread body", async () => {
  for (const status of [401, 429, 500]) {
    const stream = tracked([encode("SECRET")], status);
    await assert.rejects(json(stream.response), classified("status", status));
    assert.equal(stream.cancelled(), 1);
    assert.equal(stream.response.body?.locked, false);
  }
});

test("redirect policy is forwarded and redirected responses are explicitly rejected", async () => {
  for (const redirect of ["error", "follow"] as const) {
    const response = new Response("{}");
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "https://final.test/" },
    });
    const operation = request(url, {
      ...base,
      redirect,
      response: "json",
      fetch: async (input, init) => {
        assert.equal(input, url);
        assert.equal(init?.redirect, redirect);
        return response;
      },
    });
    if (redirect === "error") {
      await assert.rejects(operation, classified("invalid-response"));
    } else {
      assert.deepEqual(await operation, {});
    }
  }
});

test("native request method, headers, body and the deadline signal are forwarded", async () => {
  await request(url, {
    ...base,
    response: "json",
    method: "POST",
    headers: { authorization: "SECRET" },
    body: "payload",
    fetch: async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.deepEqual(init?.headers, { authorization: "SECRET" });
      assert.equal(init?.body, "payload");
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response("{}");
    },
  });
});

test("validation precedes reads and preserves business errors while cancelling", async () => {
  const stream = tracked([encode("SECRET")]);
  const businessError = new Error("business MIME rejection");
  await assert.rejects(
    request(url, {
      ...base,
      response: "json",
      fetch: async () => stream.response,
      validateResponse(meta) {
        assert.equal(meta.headers, stream.response.headers);
        assert.equal(meta.finalUrl, url);
        assert.equal(stream.response.bodyUsed, false);
        throw businessError;
      },
    }),
    (error) => error === businessError,
  );
  assert.equal(stream.cancelled(), 1);
  assert.equal(stream.response.body?.locked, false);
});

test("file writes all streamed bytes with private permissions and final metadata", async () => {
  await fixture(async (destination) => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode("abc"));
          controller.enqueue(encode("é"));
          controller.close();
        },
      }),
    );
    Object.defineProperty(response, "url", { value: "https://final.test/" });
    const result = await request(url, {
      ...base,
      response: "file",
      destination,
      maxBytes: 5,
      fetch: async () => response,
    });
    assert.equal(await readFile(destination, "utf8"), "abcé");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(result, {
      headers: response.headers,
      finalUrl: "https://final.test/",
      bytes: 5,
    });
  });
});

test("file accepts a null body or an empty stream", async () => {
  for (const body of [null, ""]) {
    await fixture(async (destination) => {
      const result = await request(url, {
        ...base,
        response: "file",
        destination,
        maxBytes: 0,
        fetch: async () => new Response(body),
      });
      assert.equal(result.bytes, 0);
      assert.equal((await stat(destination)).size, 0);
    });
  }
});

test("file checks actual bytes, removes partial files and cancels the reader", async () => {
  await fixture(async (destination) => {
    const stream = tracked([encode("abc"), encode("def")]);
    stream.response.headers.set("content-length", "1");
    await assert.rejects(
      request(url, {
        ...base,
        response: "file",
        destination,
        maxBytes: 4,
        fetch: async () => stream.response,
      }),
      classified("invalid-response"),
    );
    await missing(destination);
    assert.equal(stream.cancelled(), 1);
    assert.equal(stream.response.body?.locked, false);
  });
});

test("file read failure closes the handle and removes partial output", async () => {
  await fixture(async (destination) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encode("abc"));
        else controller.error(new Error("SECRET read failure"));
      },
    });
    await assert.rejects(
      request(url, {
        ...base,
        response: "file",
        destination,
        fetch: async () => new Response(body),
      }),
      classified("network"),
    );
    await missing(destination);
    assert.equal(body.locked, false);
  });
});

test("file deadline and parent abort cancel hanging reads and clean partial output", async () => {
  for (const timeout of [false, true]) {
    await fixture(async (destination) => {
      const parent = new AbortController();
      let cancelled = false;
      let started: (() => void) | undefined;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(encode("abc"));
            return;
          }
          started?.();
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      });
      const operation = request(url, {
        ...base,
        response: "file",
        destination,
        signal: parent.signal,
        timeoutMs: timeout ? 50 : undefined,
        fetch: async () => new Response(body),
      });
      const rejected = assert.rejects(
        within(operation),
        classified(timeout ? "timeout" : "cancelled"),
      );
      await within(reading);
      if (!timeout) parent.abort(new Error("SECRET cancel"));
      await rejected;
      // Deadline returns promptly; filesystem cleanup may finish just afterwards.
      await within(
        (async () => {
          while (true) {
            try {
              await stat(destination);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
      );
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
      assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    });
  }
});

test("file validation failure never creates a destination and cancels the body", async () => {
  await fixture(async (destination) => {
    const stream = tracked();
    const businessError = new Error("MIME");
    await assert.rejects(
      request(url, {
        ...base,
        response: "file",
        destination,
        fetch: async () => stream.response,
        validateResponse() {
          throw businessError;
        },
      }),
      (error) => error === businessError,
    );
    await missing(destination);
    assert.equal(stream.cancelled(), 1);
  });
});

test("file rejects an oversized declared length before opening the destination", async () => {
  await fixture(async (destination) => {
    const stream = tracked();
    stream.response.headers.set("content-length", "100");
    await assert.rejects(
      request(url, {
        ...base,
        response: "file",
        destination,
        fetch: async () => stream.response,
      }),
      classified("invalid-response"),
    );
    await missing(destination);
    assert.equal(stream.cancelled(), 1);
  });
});

test("file handles short writes and deletes partial output on a write failure", async () => {
  await fixture(async (destination) => {
    const probe = await open(destination, "w");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.write;
    for (const fail of [false, true]) {
      let calls = 0;
      const patched = mock.method(
        prototype,
        "write",
        async function (
          this: Awaited<ReturnType<typeof open>>,
          buffer: Uint8Array,
          offset: number,
          length: number,
        ) {
          calls++;
          if (fail && calls === 2) throw new Error("SECRET write failure");
          return original.call(this, buffer, offset, Math.min(length, 1));
        },
      );
      try {
        const operation = request(url, {
          ...base,
          response: "file",
          destination,
          fetch: async () => new Response("abcd"),
        });
        if (fail) {
          await assert.rejects(operation, classified("network"));
          await missing(destination);
        } else {
          assert.equal((await operation).bytes, 4);
          assert.equal(await readFile(destination, "utf8"), "abcd");
          assert.equal(calls, 4);
        }
      } finally {
        patched.mock.restore();
      }
    }
  });
});

test("network and body errors are sanitized", async () => {
  const fetchers: FetchLike[] = [
    async () => {
      throw new Error("SECRET network diagnostic");
    },
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error("SECRET body diagnostic");
          },
        }),
      ),
  ];
  for (const fetch of fetchers) {
    await assert.rejects(
      request(url, { ...base, response: "json", fetch }),
      classified("network"),
    );
  }
});

test("deadline races hanging fetch and hanging body including a hanging cancel", async () => {
  const fetchers: FetchLike[] = [
    () => new Promise(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
        }),
      ),
  ];
  for (const fetch of fetchers) {
    await assert.rejects(
      within(request(url, { ...base, response: "json", timeoutMs: 10, fetch })),
      classified("timeout"),
    );
  }
});

test("parent cancellation works without a request timer; preabort never fetches", async () => {
  for (const preabort of [false, true]) {
    const parent = new AbortController();
    let calls = 0;
    if (preabort) parent.abort(new Error("SECRET reason"));
    const operation = request(url, {
      ...base,
      response: "json",
      signal: parent.signal,
      fetch: () => {
        calls++;
        return new Promise(() => {});
      },
    });
    parent.abort(new Error("SECRET reason"));
    await assert.rejects(within(operation), classified("cancelled"));
    assert.equal(calls, preabort ? 0 : 1);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  }
});

test("outer deadline is preserved when request does not create its own timer", async () => {
  await assert.rejects(
    within(
      withRequestDeadline(10, undefined, (signal) =>
        request(url, {
          ...base,
          signal,
          response: "json",
          fetch: () => new Promise(() => {}),
        }),
      ),
    ),
    classified("timeout"),
  );
});

test("deadline cleans listeners/timer on success and failure, preserving run errors", async () => {
  for (const fail of [false, true]) {
    const parent = new AbortController();
    let child: AbortSignal | undefined;
    const businessError = new Error("business");
    const operation = withRequestDeadline(20, parent.signal, async (signal) => {
      child = signal;
      if (fail) throw businessError;
      return 42;
    });
    if (fail)
      await assert.rejects(operation, (error) => error === businessError);
    else assert.equal(await operation, 42);
    assert.ok(child);
    assert.equal(getEventListeners(child, "abort").length, 0);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(child.aborted, false);
  }
});

test("deadline preabort does not call run", async () => {
  const parent = new AbortController();
  parent.abort();
  await assert.rejects(
    withRequestDeadline(10, parent.signal, async () => {
      assert.fail("must not run");
    }),
    classified("cancelled"),
  );
});

test("late fetch responses are cancelled after the caller has timed out", async () => {
  const stream = tracked();
  let resolve: ((response: Response) => void) | undefined;
  await assert.rejects(
    request(url, {
      ...base,
      response: "json",
      timeoutMs: 10,
      fetch: () =>
        new Promise((done) => {
          resolve = done;
        }),
    }),
    classified("timeout"),
  );
  resolve?.(stream.response);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(stream.cancelled(), 1);
});

test("rejected status cleanup never waits for cancel or replaces the error", async () => {
  for (const fail of [false, true]) {
    const response = new Response(
      new ReadableStream({
        cancel() {
          if (fail) throw new Error("SECRET cleanup");
          return new Promise(() => {});
        },
      }),
      { status: 503 },
    );
    await assert.rejects(within(json(response)), classified("status", 503));
  }
});
