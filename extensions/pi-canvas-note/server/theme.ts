import { readFile } from "node:fs/promises";

const themePath = new URL("../theme.json", import.meta.url);
const variables = {
  background: "--background",
  surface: "--surface",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accentHover: "--accent-hover",
  onAccent: "--on-accent",
  border: "--border",
  success: "--success",
  warning: "--warning",
  error: "--error",
} as const;

// Accept only literal colors: theme data can never introduce CSS rules or URLs.
export function themeStyles(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const colors = value as Record<string, unknown>;
  const declarations = Object.entries(variables).flatMap(([key, variable]) => {
    const color = colors[key];
    return typeof color === "string" &&
      /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)
      ? [`  ${variable}: ${color};`]
      : [];
  });
  return declarations.length ? `:root {\n${declarations.join("\n")}\n}\n` : "";
}

export async function readThemeStyles(): Promise<string> {
  try {
    return themeStyles(JSON.parse(await readFile(themePath, "utf8")));
  } catch {
    // The base stylesheet remains usable with a missing or malformed theme.
    return "";
  }
}
