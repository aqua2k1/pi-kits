import type { FetchLike } from "../shared/http.ts";

export type FetchSource = "native-http" | "github-gh" | "github-clone";

export interface FetchRequest {
  readonly url: URL;
  readonly raw: boolean;
}

export interface FetchTruncation {
  readonly totalBytes: number;
  readonly outputBytes: number;
  readonly totalLines?: number;
  readonly outputLines?: number;
}

export interface FetchResponse {
  readonly text: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly finalUrl: string;
  readonly source: FetchSource;
  readonly fullOutputPath: string;
  readonly repositoryPath?: string;
  readonly truncation?: FetchTruncation;
  readonly expiresAt?: string;
}

export interface FetchHandler {
  fetch(
    request: FetchRequest,
    signal?: AbortSignal,
  ): Promise<FetchResponse | null>;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
      maxStdoutBytes: number;
      maxStderrBytes: number;
    },
  ): Promise<CommandResult>;
}

export interface GitHubHandlerCache {
  get(key: string): import("./github.ts").GitHubHandler | undefined;
  set(key: string, handler: import("./github.ts").GitHubHandler): void;
}

export interface FetchRuntime {
  readonly fetch?: FetchLike;
  readonly command?: CommandRunner;
  readonly github?: import("./github.ts").GitHubHandler;
  /** Process-local state is owned by the caller instead of a module singleton. */
  readonly githubHandlerCache?: GitHubHandlerCache;
  /** Effect capabilities supplied by the composition boundary. */
  readonly now?: () => number;
  readonly uuid?: () => string;
}
