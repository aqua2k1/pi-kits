import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readThemeStyles, themeStyles } from "../server/theme.ts";

test("theme colors map to safe CSS variables without modifying input", () => {
  const input = {
    background: "#abc",
    text: "#1234",
    accent: "#aBcDeF",
    border: "#12345678",
  };
  const before = JSON.stringify(input);
  assert.equal(
    themeStyles(input),
    ":root {\n  --background: #abc;\n  --text: #1234;\n  --accent: #aBcDeF;\n  --border: #12345678;\n}\n",
  );
  assert.equal(JSON.stringify(input), before);
  assert.equal(
    themeStyles({ accentHover: "#123456", onAccent: "#fff" }),
    ":root {\n  --accent-hover: #123456;\n  --on-accent: #fff;\n}\n",
  );
});

test("invalid colors, unknown keys and CSS injection never become declarations", () => {
  for (const value of [
    null,
    [],
    "red",
    1,
    {},
    { accent: "red" },
    { accent: "#12345" },
    { accent: "#fff; } body { display: none" },
    { accent: "url(https://example.com)" },
    { unknown: "#fff" },
    { text: 123 },
  ]) {
    assert.equal(themeStyles(value), "");
  }
  assert.equal(
    themeStyles({ accent: "bad", text: "#fff" }),
    ":root {\n  --text: #fff;\n}\n",
  );
});

test("bundled theme is completely valid and overrides stylesheet defaults", async () => {
  const value = JSON.parse(
    await readFile(new URL("../theme.json", import.meta.url), "utf8"),
  );
  const styles = await readThemeStyles();
  assert.equal(styles, themeStyles(value));
  assert.equal((styles.match(/: #/g) ?? []).length, Object.keys(value).length);
  const css = await readFile(
    new URL("../web/content.css", import.meta.url),
    "utf8",
  );
  for (const declaration of styles
    .split("\n")
    .filter((line) => line.startsWith("  --"))) {
    assert.ok(css.includes(declaration), `Missing default: ${declaration}`);
  }
  const html = await readFile(
    new URL("../web/client.html", import.meta.url),
    "utf8",
  );
  assert.ok(
    html.indexOf('href="/theme.css"') > html.indexOf('href="/client.css"'),
  );
});
