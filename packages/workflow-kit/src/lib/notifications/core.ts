import { execFile as nodeExecFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCRIPT_PATHS = {
  windows: fileURLToPath(
    new URL("./scripts/windows-toast.ps1", import.meta.url),
  ),
  linux: fileURLToPath(new URL("./scripts/linux-notify.sh", import.meta.url)),
  macos: fileURLToPath(new URL("./scripts/macos-notify.sh", import.meta.url)),
} as const;

const SCRIPT_TIMEOUT_MS = 5_000;

export type NotificationPlatform = keyof typeof SCRIPT_PATHS;

export interface ScriptExecutionOptions {
  shell: false;
  stdio: "ignore";
  timeout: number;
  windowsHide: boolean;
}

export type ExecFileCallback = (error: Error | null) => void;

export interface NotificationDependencies {
  execFile(
    file: string,
    args: string[],
    options: ScriptExecutionOptions,
    callback: ExecFileCallback,
  ): void;
}

const defaultDependencies: NotificationDependencies = {
  execFile(file, args, options, callback) {
    nodeExecFile(file, args, options, (error) => callback(error));
  },
};

/** WSL reports `linux`, but uses the Windows adapter for desktop toasts. */
export function selectNotificationPlatform(
  platform: NodeJS.Platform = process.platform,
  wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
): NotificationPlatform | undefined {
  if (platform === "win32" || (platform === "linux" && wsl)) {
    return "windows";
  }
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return undefined;
}

export function buildNotificationCommand(
  platform: NotificationPlatform,
  title: string,
  msg: string,
): { file: string; args: string[] } {
  if (platform === "windows") {
    return {
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
        title,
        "-Message",
        msg,
      ],
    };
  }

  return { file: SCRIPT_PATHS[platform], args: [title, msg] };
}

/**
 * Open a native desktop notification.
 *
 * The process launch is deliberately best-effort: true means the platform
 * command was accepted for execution, not that the OS has displayed the toast.
 */
export function sendNotification(
  title: string,
  msg: string,
  dependencies: NotificationDependencies = defaultDependencies,
): boolean {
  if (typeof title !== "string" || typeof msg !== "string") return false;

  const platform = selectNotificationPlatform();
  if (!platform) return false;

  try {
    const command = buildNotificationCommand(platform, title, msg);
    dependencies.execFile(
      command.file,
      command.args,
      {
        shell: false,
        stdio: "ignore",
        timeout: SCRIPT_TIMEOUT_MS,
        windowsHide: platform === "windows",
      },
      (error) => {
        // Delivery is best-effort. A notification failure must not affect Pi.
        void error;
      },
    );
    return true;
  } catch {
    return false;
  }
}
