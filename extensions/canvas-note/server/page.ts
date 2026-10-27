import { readFile } from "node:fs/promises";

export const pageFragmentNames = ["toolbar", "outline", "dialogs"] as const;
export type PageFragments = Record<(typeof pageFragmentNames)[number], string>;

/** Only explicit local slots are expanded; this is not a recursive include engine. */
export function assembleClientPage(
  template: string,
  fragments: PageFragments,
): string {
  let page = template;
  for (const name of pageFragmentNames) {
    const slot = new RegExp(`^([ \\t]*)<!-- include:${name} -->[ \\t]*$`, "gm");
    if ([...page.matchAll(slot)].length !== 1)
      throw new Error(`Expected exactly one page fragment slot: ${name}`);
    if (typeof fragments[name] !== "string")
      throw new Error(`Missing page fragment: ${name}`);
    if (/<!--\s*include:/.test(fragments[name]))
      throw new Error(`Nested page fragments are not allowed: ${name}`);
    page = page.replace(slot, (_match, indent: string) =>
      fragments[name]
        .trimEnd()
        .split("\n")
        .map((line) => `${indent}${line}`)
        .join("\n"),
    );
  }
  if (/<!--\s*include:/.test(page))
    throw new Error("Unknown page fragment slot");
  return page;
}

/** Load the same assembled template used by online requests and HTML export. */
export async function readClientPage(): Promise<string> {
  const root = new URL("../web/", import.meta.url);
  const [template, ...parts] = await Promise.all([
    readFile(new URL("client.html", root), "utf8"),
    ...pageFragmentNames.map((name) =>
      readFile(new URL(`fragments/${name}.html`, root), "utf8"),
    ),
  ]);
  return assembleClientPage(
    template,
    Object.fromEntries(
      pageFragmentNames.map((name, index) => [name, parts[index]]),
    ) as PageFragments,
  );
}
