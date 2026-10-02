import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildNotificationCommand,
  type NotificationDependencies,
  SCRIPT_PATHS,
  type ScriptExecutionOptions,
  selectNotificationPlatform,
  sendNotification,
} from "./core.ts";

function dependenciesFor(
  onExecute: (
    file: string,
    args: string[],
    options: ScriptExecutionOptions,
  ) => void,
): NotificationDependencies {
  return {
    execFile(file, args, options, callback) {
      onExecute(file, args, options);
      callback(null);
    },
  };
}

test("selectNotificationPlatform: maps host platforms to adapters", () => {
  assert.equal(selectNotificationPlatform("win32"), "windows");
  assert.equal(selectNotificationPlatform("linux", true), "windows");
  assert.equal(selectNotificationPlatform("linux", false), "linux");
  assert.equal(selectNotificationPlatform("darwin"), "macos");
  assert.equal(selectNotificationPlatform("freebsd", false), undefined);
});

test("platform scripts contain the notification implementation", () => {
  const windowsScript = readFileSync(SCRIPT_PATHS.windows, "utf8");
  assert.match(windowsScript, /param\(/);
  assert.match(windowsScript, /\[string\]\$Title/);
  assert.match(windowsScript, /\[string\]\$Message/);
  assert.match(windowsScript, /CreateToastNotifier/);
  assert.match(windowsScript, /ToastText02/);
  assert.match(windowsScript, /ExpirationTime.*AddMinutes\(1\)/);
  assert.doesNotMatch(windowsScript, /scenario.*reminder/);
  assert.match(windowsScript, /CreateTextNode\(\$Title\)/);
  assert.match(windowsScript, /CreateTextNode\(\$Message\)/);
  assert.match(windowsScript, /Tag = "pi-notification"/);
  assert.match(windowsScript, /Group = "Pi"/);

  const linuxScript = readFileSync(SCRIPT_PATHS.linux, "utf8");
  assert.match(linuxScript, /notify-send/);
  assert.match(linuxScript, /--expire-time=60000/);
  assert.match(linuxScript, /--replace-id/);
  assert.match(linuxScript, /--print-id/);
  assert.match(linuxScript, /\$title/);
  assert.match(linuxScript, /\$message/);
  assert.match(linuxScript, /pi-notification\.id/);

  const macosScript = readFileSync(SCRIPT_PATHS.macos, "utf8");
  assert.match(macosScript, /terminal-notifier/);
  assert.match(macosScript, /-title "\$title"/);
  assert.match(macosScript, /-message "\$message"/);
  assert.match(macosScript, /group="pi-notification"/);
  assert.match(macosScript, /sleep 60/);
  assert.match(macosScript, /-remove "\$group"/);
});

test("buildNotificationCommand: passes parameters to every adapter", () => {
  assert.deepEqual(
    buildNotificationCommand("windows", "pi", "commit message done!"),
    {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT_PATHS.windows,
        "-Title",
        "pi",
        "-Message",
        "commit message done!",
      ],
    },
  );
  assert.deepEqual(buildNotificationCommand("linux", "Build", "Finished"), {
    file: SCRIPT_PATHS.linux,
    args: ["Build", "Finished"],
  });
  assert.deepEqual(buildNotificationCommand("macos", "Build", "Finished"), {
    file: SCRIPT_PATHS.macos,
    args: ["Build", "Finished"],
  });
});

test("sendNotification: invokes the selected adapter without a shell", () => {
  const title = "Build $1";
  const msg = "Finished; do not execute";
  const platform = selectNotificationPlatform();
  assert.ok(platform);

  let invocation:
    | {
        file: string;
        args: string[];
        options: ScriptExecutionOptions;
      }
    | undefined;
  assert.equal(
    sendNotification(
      title,
      msg,
      dependenciesFor((file, args, options) => {
        invocation = { file, args, options };
      }),
    ),
    true,
  );
  assert.deepEqual(invocation, {
    ...buildNotificationCommand(platform, title, msg),
    options: {
      shell: false,
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: platform === "windows",
    },
  });
});

test("sendNotification: contains process failures", () => {
  const failingLaunch: NotificationDependencies = {
    execFile: () => {
      throw new Error("process unavailable");
    },
  };
  assert.equal(sendNotification("Pi", "Task completed.", failingLaunch), false);
});
