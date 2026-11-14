import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectWebSocket, type Socket } from "./websocket.ts";

class FakeSocket extends EventEmitter implements Socket {
  terminated = false;
  send(): void {}
  close(): void {
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
}

test("open installs the consumer before subsequent messages and clears the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  const messages: unknown[] = [];
  const connecting = connectWebSocket(
    () => socket,
    1000,
    (opened) => {
      opened.on("message", (data) => messages.push(data));
      return opened;
    },
  );
  socket.emit("open");
  socket.emit("message", "first");
  assert.equal(await connecting, socket);
  assert.deepEqual(messages, ["first"]);
  t.mock.timers.tick(1000);
  assert.equal(socket.terminated, false);
});

test("connection deadline terminates the socket and ignores a late open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  let opened = false;
  const connecting = connectWebSocket(
    () => socket,
    1000,
    () => {
      opened = true;
    },
  );
  const rejected = assert.rejects(connecting, /connection failed or timed out/);
  t.mock.timers.tick(1000);
  await rejected;
  socket.emit("open");
  assert.equal(opened, false);
  assert.equal(socket.terminated, true);
});

test("pre-open close and error reject and terminate", async () => {
  for (const event of ["close", "error"]) {
    const socket = new FakeSocket();
    const connecting = connectWebSocket(
      () => socket,
      1000,
      (opened) => opened,
    );
    socket.emit(event);
    await assert.rejects(connecting, /connection failed/);
    assert.equal(socket.terminated, true);
  }
});

test("factory and consumer failures reject without leaking an opened socket", async () => {
  await assert.rejects(
    connectWebSocket(
      () => {
        throw new Error("factory failed");
      },
      1000,
      () => {},
    ),
    /factory failed/,
  );
  const socket = new FakeSocket();
  const connecting = connectWebSocket(
    () => socket,
    1000,
    () => {
      throw new Error("consumer failed");
    },
  );
  socket.emit("open");
  await assert.rejects(connecting, /consumer failed/);
  assert.equal(socket.terminated, true);
});
