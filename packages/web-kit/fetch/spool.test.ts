import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_FETCH_CONTENT_BYTES } from "../shared/limits.ts";
import { WebFetchError } from "./errors.ts";
import {
  cleanupExpiredSpools,
  createTempSpool,
  limitUtf8Text,
} from "./spool.ts";

function fixtureDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("createTempSpool writes bounded response and final content files", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-");
  const spool = await createTempSpool(base);
  try {
    await spool.write(new TextEncoder().encode("raw response"));
    await spool.close();
    const result = await spool.saveText("final content");
    assert.equal(result.text, "final content");
    assert.equal(await readFile(spool.contentPath, "utf8"), "final content");
    await assert.rejects(stat(spool.responsePath));
    const directoryMode = (await stat(spool.directory)).mode & 0o777;
    const contentMode = (await stat(spool.contentPath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(contentMode, 0o600);
  } finally {
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("createTempSpool rejects a response over 50 MiB", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-limit-");
  const spool = await createTempSpool(base);
  try {
    await assert.rejects(
      spool.write(new Uint8Array(MAX_FETCH_CONTENT_BYTES + 1)),
      (error: unknown) =>
        error instanceof WebFetchError && error.code === "invalid-response",
    );
  } finally {
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("createTempSpool rejects writes after close and finalization", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-state-");
  const spool = await createTempSpool(base);
  try {
    await spool.close();
    await assert.rejects(
      spool.write(new TextEncoder().encode("closed")),
      (error: unknown) =>
        error instanceof WebFetchError &&
        error.code === "invalid-response" &&
        error.message === "The fetch response spool is closed.",
    );

    await spool.saveText("final content");
    await assert.rejects(
      spool.write(new TextEncoder().encode("finalized")),
      (error: unknown) =>
        error instanceof WebFetchError &&
        error.code === "invalid-response" &&
        error.message === "The fetch response has already been finalized.",
    );
  } finally {
    await spool.cleanup();
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("createTempSpool rejects repeated saveText calls", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-finalize-");
  const spool = await createTempSpool(base);
  try {
    await spool.saveText("first content");
    await assert.rejects(
      spool.saveText("second content"),
      (error: unknown) =>
        error instanceof WebFetchError && error.code === "invalid-response",
    );
  } finally {
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("createTempSpool serializes writes and reserves the size limit", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-concurrent-");
  const spool = await createTempSpool(base);
  const chunkSize = Math.floor(MAX_FETCH_CONTENT_BYTES / 2) + 1;
  const chunk = new Uint8Array(chunkSize);
  try {
    const first = spool.write(chunk);
    await assert.rejects(
      spool.write(chunk),
      (error: unknown) =>
        error instanceof WebFetchError && error.code === "invalid-response",
    );
    await first;
    assert.equal(spool.bytes, chunkSize);
    assert.equal((await stat(spool.responsePath)).size, chunkSize);
  } finally {
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("createTempSpool completes short file handle writes", async () => {
  const base = await fixtureDirectory("pi-web-tools-spool-write-");
  const probe = await open(join(base, "probe"), "w+");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    write: (
      chunk: Uint8Array,
    ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  };
  const originalWrite = fileHandlePrototype.write;
  let writeCalls = 0;
  fileHandlePrototype.write = async function (this: unknown, chunk) {
    writeCalls++;
    if (writeCalls === 1) {
      return originalWrite.call(this, chunk.subarray(0, 1));
    }
    return originalWrite.call(this, chunk);
  };

  const spool = await createTempSpool(base);
  try {
    await spool.write(new TextEncoder().encode("short file handle write"));
    assert.equal(
      await readFile(spool.responsePath, "utf8"),
      "short file handle write",
    );
    assert.equal(writeCalls, 2);
  } finally {
    fileHandlePrototype.write = originalWrite;
    await probe.close();
    await spool.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test("limitUtf8Text does not split a UTF-8 code point", () => {
  const result = limitUtf8Text("😀😀", 5);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "😀");
  assert.equal(result.outputBytes, 4);
});

test("cleanupExpiredSpools removes old fetch directories", async () => {
  const base = await fixtureDirectory("pi-web-tools-cleanup-");
  const old = join(base, "pi-web-fetch-old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "content.txt"), "old");
  await chmod(old, 0o700);
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(old, oldTime, oldTime);
  await cleanupExpiredSpools(base);
  await assert.rejects(stat(old));
  await rm(base, { recursive: true, force: true });
});
