import { MAX_GITHUB_COMMAND_OUTPUT_BYTES } from "../shared/limits.ts";
import { ProcessCommandRunner } from "./command.ts";
import {
  assertNotCancelled,
  errorFromStatus,
  WebFetchError,
} from "./errors.ts";
import type { CommandRunner } from "./types.ts";

const SOURCE = "github-gh";

export interface GhClientOptions {
  command?: CommandRunner;
  timeoutMs: number;
}

export interface GhApiResult {
  value: unknown;
}

export class GhClient {
  private readonly command: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: GhClientOptions) {
    this.command = options.command ?? new ProcessCommandRunner();
    this.timeoutMs = options.timeoutMs;
  }

  /** A missing resource returns null; operational failures never trigger HTTP fallback. */
  async apiJson(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<GhApiResult | null> {
    assertNotCancelled(signal);
    const result = await this.command.run(
      "gh",
      ["api", "--hostname", "github.com", endpoint],
      {
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: MAX_GITHUB_COMMAND_OUTPUT_BYTES,
        maxStderrBytes: 16 * 1_024,
        signal,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    assertNotCancelled(signal);
    if (result.aborted)
      throw new WebFetchError("cancelled", "Web fetch was cancelled.");
    if (result.timedOut)
      throw new WebFetchError("timeout", "The fetch request timed out.", {
        source: SOURCE,
      });
    if (result.notFound)
      throw new WebFetchError(
        "tool-unavailable",
        "GitHub reads require the local gh command.",
        { source: SOURCE },
      );
    if (result.code !== 0) {
      // gh reports HTTP status in diagnostics; never expose those diagnostics.
      const status = Number(/\bHTTP\s+(\d{3})\b/i.exec(result.stderr)?.[1]);
      if (status === 404) return null;
      if (
        status === 429 ||
        (status === 403 && /rate limit/i.test(result.stderr))
      ) {
        throw new WebFetchError(
          "rate-limit",
          "The GitHub API rate limit was reached.",
          { source: SOURCE, status },
        );
      }
      if (status) throw errorFromStatus(status, SOURCE);
      const auth =
        result.code === 4 ||
        /gh auth login|GH_TOKEN|authentication/i.test(result.stderr);
      throw new WebFetchError(
        auth ? "auth" : "request",
        "The GitHub API request failed.",
        { source: SOURCE },
      );
    }
    if (result.stdoutTruncated)
      throw new WebFetchError(
        "invalid-response",
        "The GitHub API response exceeds the size limit.",
        { source: SOURCE },
      );
    try {
      return { value: JSON.parse(result.stdout) as unknown };
    } catch {
      throw new WebFetchError(
        "invalid-response",
        "The GitHub API returned invalid JSON.",
        { source: SOURCE },
      );
    }
  }

  async repoMetadata(
    owner: string,
    repo: string,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch?: string; description?: string } | null> {
    const result = await this.apiJson(`repos/${owner}/${repo}`, signal);
    if (!result) return null;
    if (
      typeof result.value !== "object" ||
      result.value === null ||
      Array.isArray(result.value)
    ) {
      throw new WebFetchError(
        "invalid-response",
        "The GitHub API returned invalid repository metadata.",
        { source: SOURCE },
      );
    }
    const value = result.value as Record<string, unknown>;
    return {
      ...(typeof value.default_branch === "string" && value.default_branch
        ? { defaultBranch: value.default_branch }
        : {}),
      ...(typeof value.description === "string" && value.description
        ? { description: value.description }
        : {}),
    };
  }
}
