import { parentPort } from "node:worker_threads";
import { format } from "prettier";

// This worker only formats text; it never loads user config or extra plugins.
parentPort.once("message", async ({ text, parser }) => {
  try {
    parentPort.postMessage(
      await format(text, {
        parser,
        printWidth: 100,
        tabWidth: 2,
        useTabs: false,
        endOfLine: "lf",
        proseWrap: "preserve",
        htmlWhitespaceSensitivity: "css",
        embeddedLanguageFormatting: "off",
      }),
    );
  } catch {
    // Avoid copying the potentially large input back on failure.
    parentPort.postMessage(null);
  }
});
