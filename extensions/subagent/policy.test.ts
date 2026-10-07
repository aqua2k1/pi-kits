import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAutoRelease,
  type DisplayPolicySnapshot,
  dispatchBlocker,
  hasDisplayError,
  isDisplayActive,
  type ManagedPolicyRecord,
  nativeViewBlocker,
  nativeViewHint,
  resumeBlocker,
  steerBlocker,
} from "./policy.ts";
import {
  type AgentStatus,
  isBackendSessionState,
  isTerminalStatus,
  isWorkingStatus,
  nativeInputPending,
  type SessionState,
} from "./state.ts";

const statuses: AgentStatus[] = [
  "queued",
  "starting",
  "running",
  "stopping",
  "disconnected",
  "completed",
  "stopped",
  "error",
];
const states: (SessionState | undefined)[] = [
  undefined,
  "idle",
  "running",
  "interactive",
  "disconnected",
  "closed",
];
const flags = [false, true];

function record(): ManagedPolicyRecord {
  return {
    snapshot: { status: "completed", sessionState: "idle" },
    execution: { finished: true, dispatched: true },
    session: {
      connected: true,
      capabilities: {
        retainedSession: true,
        steer: true,
        concurrentNativeInput: false,
        nativeClone: false,
      },
    },
  };
}

function booleanRows(count: number): boolean[][] {
  return Array.from({ length: count }, () => flags).reduce<boolean[][]>(
    (rows, choices) =>
      rows.flatMap((row) => choices.map((value) => [...row, value])),
    [[]],
  );
}

test("resume and steer exhaustively separate lifecycle, backend, execution, connection and capabilities", () => {
  for (const status of statuses) {
    for (const sessionState of states) {
      for (const [
        finished,
        dispatched,
        connected,
        retainedSession,
        steer,
        releaseRequested,
        terminating,
      ] of booleanRows(7)) {
        const r = record();
        r.snapshot = { status, sessionState };
        r.execution = { finished, dispatched };
        assert.ok(r.session);
        r.session.connected = connected;
        r.session.capabilities = {
          ...r.session.capabilities,
          retainedSession,
          steer,
        };
        r.releaseRequested = releaseRequested;
        r.terminating = terminating;
        const context = JSON.stringify(r);
        const resume =
          releaseRequested || sessionState === "closed"
            ? "closed/released"
            : !finished
              ? "finished managed"
              : terminating
                ? "cleanup"
                : !connected || !retainedSession
                  ? "retained, connected"
                  : sessionState !== "idle"
                    ? "idle session"
                    : undefined;
        const steering =
          status !== "running" ||
          sessionState !== "running" ||
          finished ||
          !dispatched ||
          !connected ||
          releaseRequested ||
          terminating
            ? "connected running managed"
            : !steer
              ? "does not support"
              : undefined;
        for (const [actual, expected] of [
          [resumeBlocker(r), resume],
          [steerBlocker(r), steering],
        ]) {
          if (expected) assert.ok(actual?.includes(expected), context);
          else assert.equal(actual, undefined, context);
        }
      }
    }
  }
  const missing = record();
  missing.session = undefined;
  assert.match(resumeBlocker(missing) ?? "", /retained, connected/);
  assert.match(steerBlocker(missing) ?? "", /connected running managed/);
});

test("dispatch classification preserves startup disconnect vs queued rejection and ignores finished", () => {
  for (const sessionState of states) {
    for (const [
      connected,
      finished,
      releaseRequested,
      terminating,
    ] of booleanRows(4)) {
      const r = record();
      assert.ok(r.session);
      r.session.connected = connected;
      r.snapshot.sessionState = sessionState;
      r.execution.finished = finished;
      r.releaseRequested = releaseRequested;
      r.terminating = terminating;
      assert.equal(
        dispatchBlocker(r, "startup"),
        !connected ||
          sessionState === "closed" ||
          sessionState === "disconnected"
          ? "disconnected"
          : sessionState !== "idle"
            ? "busy"
            : undefined,
      );
      assert.equal(
        dispatchBlocker(r, "resume"),
        !connected || releaseRequested || terminating || sessionState !== "idle"
          ? "busy"
          : undefined,
      );
    }
  }
});

test("view and auto-release use independent ownership and completion facts", () => {
  for (const sessionState of states) {
    for (const [
      finished,
      releaseRequested,
      keepAlive,
      disposed,
      concurrentNativeInput,
      sessionClosed,
      terminating,
    ] of booleanRows(7)) {
      const r = record();
      assert.ok(r.session);
      r.snapshot = { status: "completed", sessionState, keepAlive };
      r.execution.finished = finished;
      r.releaseRequested = releaseRequested;
      r.terminating = terminating;
      r.session.capabilities.concurrentNativeInput = concurrentNativeInput;
      assert.equal(
        canAutoRelease(r, disposed),
        !disposed &&
          !releaseRequested &&
          !keepAlive &&
          finished &&
          sessionState !== "closed" &&
          sessionState !== "interactive",
      );
      const expected =
        releaseRequested ||
        sessionState === "closed" ||
        terminating ||
        sessionClosed
          ? "closed/released"
          : !finished && !concurrentNativeInput
            ? "requires no managed task"
            : undefined;
      const actual = nativeViewBlocker(r, sessionClosed);
      if (expected) assert.ok(actual?.includes(expected));
      else assert.equal(actual, undefined);
    }
  }
  const missing = record();
  missing.session = undefined;
  assert.match(nativeViewBlocker(missing, false) ?? "", /not ready/);
});

test("display classifications are shared; terminal presence cannot bypass unfinished capability hint", () => {
  for (const status of statuses) {
    assert.equal(
      isTerminalStatus(status),
      ["completed", "stopped", "error"].includes(status),
    );
    assert.equal(
      isWorkingStatus(status),
      ["starting", "running", "stopping"].includes(status),
    );
    for (const sessionState of states) {
      const r = record();
      assert.ok(r.session);
      for (const concurrentNativeInput of flags) {
        const agent: DisplayPolicySnapshot = {
          status,
          sessionState,
          terminalId: "terminal",
          capabilities: { ...r.session.capabilities, concurrentNativeInput },
        };
        assert.equal(
          nativeViewHint(agent),
          sessionState !== "closed" &&
            (isTerminalStatus(status) || concurrentNativeInput),
        );
        assert.equal(
          isDisplayActive(agent),
          isWorkingStatus(status) || sessionState === "interactive",
        );
        assert.equal(
          hasDisplayError(agent),
          status === "error" ||
            status === "disconnected" ||
            sessionState === "disconnected",
        );
      }
    }
  }
  assert.equal(
    nativeViewHint({ status: "running", terminalId: "terminal" }),
    false,
  );
  for (const state of ["idle", "running", "interactive"] as const) {
    assert.ok(isBackendSessionState(state));
    for (const idle of flags)
      assert.equal(
        nativeInputPending(state, idle),
        state === "interactive" || !idle,
      );
  }
  for (const invalid of [undefined, null, 1, "closed", "disconnected", ""])
    assert.equal(isBackendSessionState(invalid), false);
});
