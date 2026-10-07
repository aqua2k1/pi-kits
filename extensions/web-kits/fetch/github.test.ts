import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ResolvedGitHubFetchConfig } from "../config.ts";
import { MAX_GITHUB_SESSION_CLONES } from "../shared/limits.ts";
import { GitHubHandler } from "./github.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    notFound: false,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function config(
  clonePath: string,
  overrides: Partial<ResolvedGitHubFetchConfig> = {},
): ResolvedGitHubFetchConfig {
  return {
    enabled: true,
    mode: "auto",
    maxRepoSizeMB: 350,
    cloneTimeoutSeconds: 30,
    clonePath,
    ...overrides,
  };
}

async function cleanupResult(path: string): Promise<void> {
  await rm(path.substring(0, path.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
}

test("GitHubHandler shallow-clones a small repository and saves content locally", async () => {
  const clonePath = `/tmp/pi-web-tools-github-test-${Date.now()}-clone`;
  let cloneCalls = 0;
  const apiEndpoints: string[] = [];
  const apiTimeouts: number[] = [];
  const cloneTimeouts: number[] = [];
  const command: CommandRunner = {
    async run(commandName, args, options) {
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      if (commandName === "gh" && args[0] === "api") {
        apiTimeouts.push(options.timeoutMs);
        apiEndpoints.push(String(args.at(-1)));
        if (String(args.at(-1)).includes("matching-refs")) {
          return result({
            stdout: JSON.stringify(
              String(args.at(-1)).includes("/heads/")
                ? [{ ref: "refs/heads/main" }]
                : [],
            ),
          });
        }
        return result({
          stdout: JSON.stringify({ default_branch: "main", size: 12 }),
        });
      }
      if (commandName === "gh" && args[0] === "repo") {
        cloneCalls++;
        cloneTimeouts.push(options.timeoutMs);
        const destination = args[3] as string;
        await mkdir(`${destination}/src`, { recursive: true });
        await writeFile(`${destination}/README.md`, "# Example\n");
        await writeFile(`${destination}/src/index.ts`, "export const x = 1;\n");
        return result();
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });

  const first = await handler.fetch({
    url: new URL("https://github.com/acme/project/blob/main/src/index.ts"),
  });
  assert.ok(first);
  assert.equal(first.source, "github-clone");
  assert.equal(first.repositoryPath !== undefined, true);
  assert.match(first.text, /export const x = 1/);
  assert.equal(cloneCalls, 1);
  const refEndpoints = [
    "repos/acme/project/git/matching-refs/heads/main",
    "repos/acme/project/git/matching-refs/tags/main",
  ];
  assert.deepEqual(apiEndpoints, [...refEndpoints, "repos/acme/project"]);
  assert.equal(
    await readFile(first.fullOutputPath, "utf8").then((text) =>
      text.includes("export const x = 1"),
    ),
    true,
  );

  const second = await handler.fetch({
    url: new URL("https://github.com/acme/project"),
  });
  assert.ok(second);
  assert.equal(cloneCalls, 1);
  assert.deepEqual(apiEndpoints, [
    ...refEndpoints,
    "repos/acme/project",
    "repos/acme/project",
  ]);
  assert.deepEqual(apiTimeouts, [1_000, 1_000, 1_000, 1_000]);
  assert.deepEqual(cloneTimeouts, [30_000]);
  assert.equal(second.repositoryPath, first.repositoryPath);
  await cleanupResult(first.fullOutputPath);
  await cleanupResult(second.fullOutputPath);
  await rm(clonePath, { recursive: true, force: true });
});

test("GitHubHandler uses gh api in api mode", async () => {
  const seen: string[][] = [];
  const command: CommandRunner = {
    async run(commandName, args) {
      seen.push([commandName, ...args]);
      if (args[0] === "--version") return result({ stdout: "gh version 2\n" });
      if (
        args[0] === "api" &&
        String(args.at(-1)).startsWith("repos/acme/project")
      ) {
        const endpoint = String(args.at(-1));
        if (endpoint.includes("contents")) {
          return result({
            stdout: JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("hello from api\n").toString("base64"),
            }),
          });
        }
        return result({
          stdout: JSON.stringify({ default_branch: "main", size: 1 }),
        });
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config("/tmp/pi-web-tools-api-test", { mode: "api" }),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const response = await handler.fetch({
    url: new URL("https://github.com/acme/project/blob/main/README.md"),
  });
  assert.ok(response);
  assert.equal(response.source, "github-gh");
  assert.match(response.text, /hello from api/);
  assert.equal(
    seen.some((call) => call[0] === "gh" && call[1] === "api"),
    true,
  );
  assert.equal(
    seen.some(
      (call) =>
        call[0] === "gh" &&
        call[1] === "api" &&
        call.at(-1) === "repos/acme/project",
    ),
    false,
  );
  await cleanupResult(response.fullOutputPath);
});

test("GitHubHandler does not clone a known oversized repository when API returns null", async () => {
  const clonePath = `/tmp/pi-web-tools-github-oversized-${Date.now()}`;
  let cloneCalls = 0;
  const command: CommandRunner = {
    async run(commandName, args) {
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      if (commandName === "gh" && args[0] === "api") {
        const endpoint = String(args.at(-1));
        if (endpoint === "repos/acme/large") {
          return result({
            stdout: JSON.stringify({ default_branch: "main", size: 1_000_000 }),
          });
        }
        return result({ code: 1 });
      }
      if (commandName === "gh" && args[0] === "repo") cloneCalls++;
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath, { maxRepoSizeMB: 10 }),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });

  const response = await handler.fetch({
    url: new URL("https://github.com/acme/large"),
  });
  assert.equal(response, null);
  assert.equal(cloneCalls, 0);
  await rm(clonePath, { recursive: true, force: true });
});

test("GitHubHandler lets each in-flight clone waiter cancel independently", async () => {
  const clonePath = `/tmp/pi-web-tools-github-cancel-${Date.now()}`;
  let cloneStarted!: () => void;
  let releaseClone!: () => void;
  const started = new Promise<void>((resolve) => {
    cloneStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseClone = resolve;
  });
  const command: CommandRunner = {
    async run(commandName, args, options) {
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      if (commandName === "gh" && args[0] === "repo") {
        cloneStarted();
        const aborted = new Promise<"aborted">((resolve) => {
          options.signal?.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        });
        if (
          (await Promise.race([released.then(() => "released"), aborted])) ===
          "aborted"
        ) {
          return result({ aborted: true });
        }
        const destination = args[3] as string;
        await mkdir(destination, { recursive: true });
        await writeFile(`${destination}/README.md`, "shared clone\n");
        return result();
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath, { mode: "clone" }),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const request = {
    url: new URL("https://github.com/acme/project/blob/main/README.md"),
  };
  const controller = new AbortController();
  const first = handler.fetch(request, controller.signal);
  await started;
  interface TestCloneOperation {
    waiters: number;
  }
  const privateHandler = handler as unknown as {
    clones: Map<string, TestCloneOperation>;
    waitForClone(
      operation: TestCloneOperation,
      signal?: AbortSignal,
    ): Promise<string | null>;
  };
  const operation = [...privateHandler.clones.values()][0];
  assert.ok(operation);
  const second = privateHandler.waitForClone(operation);
  assert.equal(operation.waiters, 2);
  controller.abort();
  await assert.rejects(first, (error: unknown) => {
    return (
      error instanceof Error && "code" in error && error.code === "cancelled"
    );
  });

  releaseClone();
  const repositoryPath = await second;
  assert.ok(repositoryPath);
  assert.equal(operation.waiters, 0);
  await rm(clonePath, { recursive: true, force: true });
});

test("GitHubHandler aborts cloning when its final waiter cancels", async () => {
  const clonePath = `/tmp/pi-web-tools-github-owner-${Date.now()}`;
  let cloneStarted!: () => void;
  let cloneAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    cloneStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    cloneAborted = resolve;
  });
  const command: CommandRunner = {
    async run(commandName, args, options) {
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      if (commandName === "gh" && args[0] === "repo") {
        cloneStarted();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              cloneAborted();
              resolve();
            },
            { once: true },
          );
        });
        return result({ aborted: true });
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const controller = new AbortController();
  const response = handler.fetch(
    {
      url: new URL("https://github.com/acme/project/blob/main/README.md"),
    },
    controller.signal,
  );

  await started;
  controller.abort();
  await assert.rejects(response, (error: unknown) => {
    return (
      error instanceof Error && "code" in error && error.code === "cancelled"
    );
  });
  await aborted;
  await rm(clonePath, { recursive: true, force: true });
});

test("GitHubHandler reserves clone capacity before starting distinct clones", async () => {
  const clonePath = `/tmp/pi-web-tools-github-capacity-${Date.now()}`;
  let cloneCalls = 0;
  let maxClonesStarted!: () => void;
  let releaseClones!: () => void;
  const maxStarted = new Promise<void>((resolve) => {
    maxClonesStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseClones = resolve;
  });
  const command: CommandRunner = {
    async run(commandName, args) {
      if (commandName === "gh" && args[0] === "--version") {
        return result({ stdout: "gh version 2\n" });
      }
      if (commandName === "gh" && args[0] === "repo") {
        cloneCalls++;
        if (cloneCalls === MAX_GITHUB_SESSION_CLONES) maxClonesStarted();
        await released;
        const destination = args[3] as string;
        await mkdir(destination, { recursive: true });
        await writeFile(`${destination}/README.md`, "capacity clone\n");
        return result();
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const requests = Array.from(
    { length: MAX_GITHUB_SESSION_CLONES + 1 },
    (_, index) => ({
      url: new URL(
        `https://github.com/acme/project/blob/ref-${index}/README.md`,
      ),
    }),
  );
  const fetches = requests.map((request) => handler.fetch(request));
  await maxStarted;
  assert.equal(cloneCalls, MAX_GITHUB_SESSION_CLONES);
  releaseClones();
  const responses = await Promise.all(fetches);
  assert.equal(
    responses.filter((response) => response?.source === "github-clone").length,
    MAX_GITHUB_SESSION_CLONES,
  );
  for (const response of responses) {
    if (response) await cleanupResult(response.fullOutputPath);
  }
  await rm(clonePath, { recursive: true, force: true });
});

test("GitHubHandler keeps implicit default and a branch named default in separate clone caches", async () => {
  const clonePath = `/tmp/pi-web-tools-default-ref-${Date.now()}`;
  const branches: (string | undefined)[] = [];
  const command: CommandRunner = {
    async run(_name, args) {
      if (args[0] === "--version") return result();
      if (args[0] === "repo") {
        const branchIndex = args.indexOf("--branch");
        const branch = branchIndex < 0 ? undefined : args[branchIndex + 1];
        branches.push(branch);
        const destination = args[3] as string;
        await mkdir(destination, { recursive: true });
        await writeFile(`${destination}/README.md`, branch ?? "implicit");
        return result();
      }
      return result({ code: 1 });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath, { mode: "clone" }),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const responses = [];
  try {
    for (const suffix of ["", "/tree/default", "", "/tree/default"]) {
      const response = await handler.fetch({
        url: new URL(`https://github.com/acme/project${suffix}`),
      });
      assert.ok(response);
      responses.push(response);
    }
    assert.deepEqual(branches, [undefined, "default"]);
    assert.notEqual(responses[0]?.repositoryPath, responses[1]?.repositoryPath);
    assert.equal(responses[0]?.repositoryPath, responses[2]?.repositoryPath);
    assert.equal(responses[1]?.repositoryPath, responses[3]?.repositoryPath);
  } finally {
    for (const response of responses)
      await cleanupResult(response.fullOutputPath);
    await rm(clonePath, { recursive: true, force: true });
  }
});

test("GitHubHandler resolves slash refs before API/clone and declines ambiguous refs", async () => {
  for (const mode of ["api", "clone"] as const) {
    const clonePath = `/tmp/pi-web-tools-slash-${mode}-${Date.now()}`;
    const endpoints: string[] = [];
    const branches: string[] = [];
    let ambiguous = false;
    const command: CommandRunner = {
      async run(_name, args) {
        if (args[0] === "--version") return result();
        if (args[0] === "api") {
          const endpoint = String(args.at(-1));
          endpoints.push(endpoint);
          if (endpoint.includes("matching-refs")) {
            return result({
              stdout: JSON.stringify(
                endpoint.includes("/heads/")
                  ? [
                      { ref: "refs/heads/feature/topic" },
                      ...(ambiguous ? [{ ref: "refs/heads/feature" }] : []),
                    ]
                  : [],
              ),
            });
          }
          if (
            endpoint ===
            "repos/acme/project/contents/src/file.ts?ref=feature%2Ftopic"
          ) {
            return result({
              stdout: JSON.stringify({
                type: "file",
                content: Buffer.from("slash branch\n").toString("base64"),
              }),
            });
          }
          return result({ code: 1 });
        }
        if (args[0] === "repo") {
          branches.push(args[args.indexOf("--branch") + 1] as string);
          const destination = args[3] as string;
          await mkdir(`${destination}/src`, { recursive: true });
          await writeFile(`${destination}/src/file.ts`, "slash branch\n");
          return result();
        }
        return result({ code: 1 });
      },
    };
    const handler = new GitHubHandler({
      config: config(clonePath, { mode }),
      apiTimeoutMs: 1_000,
      runtime: { command },
    });
    try {
      for (const ref of ["feature/topic", "feature%2Ftopic"]) {
        const response = await handler.fetch({
          url: new URL(
            `https://github.com/acme/project/blob/${ref}/src/file.ts`,
          ),
        });
        assert.ok(response);
        assert.match(response.text, /slash branch/);
        await cleanupResult(response.fullOutputPath);
      }
      if (mode === "clone") assert.deepEqual(branches, ["feature/topic"]);
      else
        assert.equal(
          endpoints.filter((endpoint) =>
            endpoint.includes("contents/src/file.ts?ref=feature%2Ftopic"),
          ).length,
          2,
        );
      ambiguous = true;
      const before = branches.length;
      assert.equal(
        await handler.fetch({
          url: new URL(
            "https://github.com/acme/project/blob/feature/topic/src/file.ts",
          ),
        }),
        null,
      );
      assert.equal(branches.length, before);
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }
  }
});

test("GitHubHandler falls back to public git when gh is unavailable", async () => {
  const clonePath = `/tmp/pi-web-tools-git-test-${Date.now()}`;
  const command: CommandRunner = {
    async run(commandName, args) {
      if (commandName === "gh") return result({ notFound: true, code: null });
      if (commandName === "git") {
        const destination = args.at(-1) as string;
        await mkdir(destination, { recursive: true });
        await writeFile(`${destination}/README.md`, "public repo");
        return result();
      }
      return result({ notFound: true, code: null });
    },
  };
  const handler = new GitHubHandler({
    config: config(clonePath),
    apiTimeoutMs: 1_000,
    runtime: { command },
  });
  const response = await handler.fetch({
    url: new URL("https://github.com/acme/project"),
  });
  assert.ok(response);
  assert.equal(response.source, "github-clone");
  assert.match(response.text, /public repo/);
  await cleanupResult(response.fullOutputPath);
  await rm(clonePath, { recursive: true, force: true });
});
