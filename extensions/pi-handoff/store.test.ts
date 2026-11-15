import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  backupHandoff,
  handoffId,
  handoffPath,
  listHandoffs,
  metadataHeader,
  readHandoff,
} from "./store.ts";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-handoff-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = {
    id: handoffId("/project", "session"),
    project: "/project",
    sessionId: "session",
    title: "Title",
    updatedAt: new Date().toISOString(),
  };
  const path = handoffPath(directory, metadata.id);
  return { directory, metadata, path };
}

test("manual CRLF saves retain readable metadata and original bytes", async (t) => {
  const { directory, metadata, path } = await fixture(t);
  const crlf = `${metadataHeader(metadata)}\r\n\r\n# Handoff\r\n\r\n## 下一会话目标\r\nTests\r\n`;
  await writeFile(path, crlf);
  const document = await readHandoff(directory, metadata.id);
  assert.equal(document?.raw, crlf);
  assert.match(document?.body ?? "", /Tests/);
});

test("metadata-only files have an empty body and malformed metadata is rejected", async (t) => {
  const { directory, metadata, path } = await fixture(t);
  await writeFile(path, metadataHeader(metadata));
  assert.equal((await readHandoff(directory, metadata.id))?.body, "");
  for (const raw of [
    "<!-- pi-handoff null -->",
    "<!-- pi-handoff {} -->",
    "not metadata",
  ]) {
    await writeFile(path, raw);
    await assert.rejects(
      () => readHandoff(directory, metadata.id),
      /Invalid handoff metadata/,
    );
  }
});

test("backups preserve exact manual edits, use private permissions and stay out of selection", async (t) => {
  const { directory, metadata, path } = await fixture(t);
  const original = `${metadataHeader(metadata)}\n\nOriginal\n手动修改\n`;
  await writeFile(path, original);
  const document = await readHandoff(directory, metadata.id);
  assert.ok(document);
  const backup = await backupHandoff(directory, document);
  assert.equal(await readFile(backup, "utf8"), original);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal((await listHandoffs(directory, metadata.project)).length, 1);
});

test("metadata serializer safely escapes multiline titles and comment terminators", async (t) => {
  const { directory, metadata, path } = await fixture(t);
  metadata.title = 'Line 1\nLine 2 --> "quoted"';
  const header = metadataHeader(metadata);
  assert.equal(header.split("\n").length, 1);
  assert.equal(header.indexOf("-->"), header.length - 3);
  await writeFile(path, `${header}\n\nBody`);
  assert.equal(
    (await readHandoff(directory, metadata.id))?.title,
    metadata.title,
  );
});
