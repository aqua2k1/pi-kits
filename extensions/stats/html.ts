import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doOpen } from "@pi-kits/shared/desktop-open";
import type { StatsReport } from "./report.ts";

export type {
  StatsHtmlData,
  StatsHtmlDate,
  StatsHtmlModel,
  StatsHtmlPeriod,
} from "./report.ts";
export { buildStatsReport as serializeStatsSnapshot } from "./report.ts";

const TEMPLATE_URL = new URL("./template.html", import.meta.url);
const DATA_PLACEHOLDER = '"{{STATS_DATA}}"';

function escapeJsonForHtml(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderStatsHtml(report: StatsReport): string {
  const data = escapeJsonForHtml(JSON.stringify(report));
  const template = readFileSync(TEMPLATE_URL, "utf8");
  if (!template.includes(DATA_PLACEHOLDER)) {
    throw new Error("Stats HTML template is missing its data placeholder");
  }
  return template.replace(DATA_PLACEHOLDER, data);
}

export async function writeStatsHtmlSnapshot(
  report: StatsReport,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-stats-"));
  const filePath = path.join(directory, "stats.html");
  try {
    await writeFile(filePath, renderStatsHtml(report), {
      encoding: "utf8",
      mode: 0o600,
    });
    return filePath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function openStatsHtml(
  report: StatsReport,
  open: typeof doOpen = doOpen,
): Promise<string> {
  const filePath = await writeStatsHtmlSnapshot(report);
  const result = await open(filePath);
  if (!result.ok) throw new Error(result.message);
  return filePath;
}
