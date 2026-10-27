import { readFileSync } from "node:fs";
import {
  assembleClientPage,
  type PageFragments,
  pageFragmentNames,
} from "../../server/page.ts";

/** The minimal browser harness consumes the server's real assembled markup. */
export function clientPage(): string {
  const root = new URL("../../web/", import.meta.url);
  const fragments = Object.fromEntries(
    pageFragmentNames.map((name) => [
      name,
      readFileSync(new URL(`fragments/${name}.html`, root), "utf8"),
    ]),
  ) as PageFragments;
  return assembleClientPage(
    readFileSync(new URL("client.html", root), "utf8"),
    fragments,
  );
}
