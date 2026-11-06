import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createSearxngProvider } from "./provider.ts";

test("native fetch cannot forward a search or its credentials through a redirect", async () => {
  let searchCalls = 0;
  let redirectedCalls = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/search?")) {
      searchCalls++;
      assert.equal(request.headers.authorization, "Bearer fixture-local-key");
      response.writeHead(307, { Location: "/sink" }).end();
    } else {
      redirectedCalls++;
      response.end('{"results":[]}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createSearxngProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "fixture-local-key",
    });
    await assert.rejects(
      provider.search({ query: "fixture-query", maxResults: 1 }),
      { code: "network" },
    );
    assert.equal(searchCalls, 1);
    assert.equal(redirectedCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
