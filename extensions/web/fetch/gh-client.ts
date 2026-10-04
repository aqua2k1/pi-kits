import { MAX_GITHUB_COMMAND_OUTPUT_BYTES } from "../shared/limits.ts";
import { ProcessCommandRunner } from "./command.ts";
import { assertNotCancelled, WebFetchError } from "./errors.ts";
import type { CommandRunner } from "./types.ts";

const GH_SOURCE = "github-gh";
const GIT_SOURCE = "github-clone";

export interface GhClientOptions {
  command?: CommandRunner;
  timeoutMs: number;
}

export interface CloneOptions {
  owner: string;
  repo: string;
  ref?: string;
  destination: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GhApiResult {
  value: unknown;
}

function commandOptions(
  timeoutMs: number,
  signal?: AbortSignal,
): {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
} {
  return {
    timeoutMs,
    maxStdoutBytes: MAX_GITHUB_COMMAND_OUTPUT_BYTES,
    maxStderrBytes: 16 * 1_024,
    signal,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    },
  };
}

export class GhClient {
  private readonly command: CommandRunner;
  private readonly timeoutMs: number;
  private ghAvailable: boolean | undefined;

  constructor(options: GhClientOptions) {
    this.command = options.command ?? new ProcessCommandRunner();
    this.timeoutMs = options.timeoutMs;
  }

  async isGhAvailable(signal?: AbortSignal): Promise<boolean> {
    assertNotCancelled(signal);
    if (this.ghAvailable !== undefined) return this.ghAvailable;
    const result = await this.command.run(
      "gh",
      ["--version"],
      commandOptions(Math.min(this.timeoutMs, 5_000), signal),
    );
    if (result.aborted)
      throw new WebFetchError("cancelled", "Web fetch was cancelled.");
    if (result.timedOut) {
      this.ghAvailable = false;
      return false;
    }
    this.ghAvailable = !result.notFound && result.code === 0;
    return this.ghAvailable;
  }

  async apiJson(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<GhApiResult | null> {
    if (!(await this.isGhAvailable(signal))) return null;
    const result = await this.command.run(
      "gh",
      ["api", "--hostname", "github.com", endpoint],
      commandOptions(this.timeoutMs, signal),
    );
    assertNotCancelled(signal);
    if (result.timedOut) {
      throw new WebFetchError("timeout", "The fetch request timed out", {
        source: GH_SOURCE,
      });
    }
    if (result.notFound) return null;
    if (result.stdoutTruncated) {
      throw new WebFetchError(
        "invalid-response",
        "The GitHub API response exceeds the size limit.",
        { source: GH_SOURCE },
      );
    }
    if (result.code !== 0) return null;
    try {
      return {
        value: JSON.parse(result.stdout) as unknown,
      };
    } catch {
      throw new WebFetchError(
        "invalid-response",
        "The GitHub API returned invalid JSON.",
        { source: GH_SOURCE },
      );
    }
  }

  async repoMetadata(
    owner: string,
    repo: string,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch?: string; sizeMB?: number } | null> {
    const result = await this.apiJson(`repos/${owner}/${repo}`, signal);
    if (!result || typeof result.value !== "object" || result.value === null) {
      return null;
    }
    const value = result.value as Record<string, unknown>;
    const defaultBranch =
      typeof value.default_branch === "string" && value.default_branch
        ? value.default_branch
        : undefined;
    const sizeKB = typeof value.size === "number" ? value.size : undefined;
    return {
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(sizeKB !== undefined && Number.isFinite(sizeKB)
        ? { sizeMB: sizeKB / 1_024 }
        : {}),
    };
  }

  async clone(options: CloneOptions): Promise<boolean> {
    assertNotCancelled(options.signal);
    const ghAvailable = await this.isGhAvailable(options.signal);
    if (ghAvailable) {
      const args = [
        "repo",
        "clone",
        `${options.owner}/${options.repo}`,
        options.destination,
        "--",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
      ];
      if (options.ref) args.push("--branch", options.ref);
      const result = await this.command.run(
        "gh",
        args,
        commandOptions(options.timeoutMs, options.signal),
      );
      if (result.aborted)
        throw new WebFetchError("cancelled", "Web fetch was cancelled.");
      if (result.timedOut) {
        throw new WebFetchError("timeout", "The fetch request timed out.", {
          source: GIT_SOURCE,
        });
      }
      if (!result.notFound && result.code === 0) return true;
    }

    assertNotCancelled(options.signal);
    const gitUrl = `https://github.com/${options.owner}/${options.repo}.git`;
    const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (options.ref) args.push("--branch", options.ref);
    args.push(gitUrl, options.destination);
    const result = await this.command.run(
      "git",
      args,
      commandOptions(options.timeoutMs, options.signal),
    );
    if (result.aborted)
      throw new WebFetchError("cancelled", "Web fetch was cancelled.");
    if (result.timedOut) {
      throw new WebFetchError("timeout", "The fetch request timed out.", {
        source: GIT_SOURCE,
      });
    }
    if (result.notFound) return false;
    return result.code === 0;
  }
}
