import assert from "node:assert/strict";
import { test } from "node:test";
import { removeDocs } from "./index.ts";

const cases = [
  {
    name: "removes multiline docs and trailing whitespace",
    input: "prefix\n<docs>\nline one\nline two\n</docs>\n\n<cwd>/project</cwd>",
    expected: "prefix\n<cwd>/project</cwd>",
  },
  {
    name: "removes every docs block without swallowing content between blocks",
    input: "a<docs>first</docs>b<docs>second</docs>c",
    expected: "abc",
  },
  {
    name: "removes an empty docs block",
    input: "<docs></docs>",
    expected: "",
  },
  {
    name: "preserves other sections and whitespace when docs are absent",
    input: " \n<rules>rules</rules>\n<cwd>/project</cwd>\n",
    expected: " \n<rules>rules</rules>\n<cwd>/project</cwd>\n",
  },
  {
    name: "preserves similar tags and incomplete docs blocks",
    input: "<documentation>x</documentation><DOCS>x</DOCS><docs>unfinished",
    expected: "<documentation>x</documentation><DOCS>x</DOCS><docs>unfinished",
  },
  {
    name: "preserves an empty prompt",
    input: "",
    expected: "",
  },
];

for (const { name, input, expected } of cases) {
  test(name, () => {
    assert.equal(removeDocs(input), expected);
  });
}
