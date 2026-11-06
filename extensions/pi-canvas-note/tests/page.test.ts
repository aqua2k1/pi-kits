import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleClientPage,
  type PageFragments,
  readClientPage,
} from "../server/page.ts";
import { clientPage } from "./fixtures/client-page.ts";

const template =
  "<body>\n  <!-- include:toolbar -->\n  <!-- include:outline -->\n  <!-- include:dialogs -->\n</body>";
const fragments: PageFragments = Object.freeze({
  toolbar: "<header>Toolbar $&</header>\n",
  outline: "<aside>\n  Outline\n</aside>\n",
  dialogs: "<dialog>Reply</dialog>\n",
});

test("page assembly is pure, preserves markup and expands only explicit local slots", () => {
  const before = JSON.stringify(fragments);
  assert.equal(
    assembleClientPage(template, fragments),
    "<body>\n  <header>Toolbar $&</header>\n  <aside>\n    Outline\n  </aside>\n  <dialog>Reply</dialog>\n</body>",
  );
  assert.equal(JSON.stringify(fragments), before);
});

test("missing, duplicate, nested and unknown fragment slots fail rather than serving partial pages", () => {
  assert.throws(
    () =>
      assembleClientPage(
        template.replace("<!-- include:outline -->", ""),
        fragments,
      ),
    /exactly one.*outline/,
  );
  assert.throws(
    () =>
      assembleClientPage(`${template}\n<!-- include:toolbar -->`, fragments),
    /exactly one.*toolbar/,
  );
  assert.throws(
    () =>
      assembleClientPage(template, {
        ...fragments,
        dialogs: "<!-- include:outline -->",
      }),
    /Nested/,
  );
  assert.throws(
    () =>
      assembleClientPage(`${template}\n<!-- include:../private -->`, fragments),
    /Unknown/,
  );
});

test("server and browser harness use the same fully assembled page with stable unique IDs", async () => {
  const html = await readClientPage();
  assert.equal(html, clientPage());
  assert.doesNotMatch(html, /<!--\s*include:/);
  assert.match(html, /<header class="toolbar">/);
  assert.match(html, /<aside id="outline"/);
  assert.match(html, /<dialog id="reply-dialog"/);
  assert.match(html, /<dialog id="shutdown-dialog"/);
  assert.match(html, /id="document-data" type="application\/json"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
