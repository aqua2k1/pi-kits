import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelKeys, type StatsSnapshot, type UsageTotals } from "./core.ts";

const TEMPLATE_URL = new URL("./template.html", import.meta.url);
const DATA_PLACEHOLDER = '"{{STATS_DATA}}"';

export interface StatsHtmlModel {
  model: string;
  totalTokens: number;
  cost: number;
}

export interface StatsHtmlDate {
  day: string;
  models: StatsHtmlModel[];
}

export interface StatsHtmlPeriod {
  total: UsageTotals;
  models: StatsHtmlModel[];
}

export interface StatsHtmlData {
  generatedAt: string;
  total: UsageTotals;
  models: StatsHtmlModel[];
  dates: StatsHtmlDate[];
  periods: {
    total: StatsHtmlPeriod;
    last30Days: StatsHtmlPeriod;
    last24Hours: StatsHtmlPeriod;
  };
}

function modelData(model: string, totals: UsageTotals): StatsHtmlModel {
  return {
    model,
    totalTokens: totals.totalTokens,
    cost: totals.cost,
  };
}

function sortModelTotals(
  modelTotals: Map<string, UsageTotals>,
): StatsHtmlModel[] {
  return [...modelTotals.entries()]
    .sort(
      ([leftModel, leftTotals], [rightModel, rightTotals]) =>
        rightTotals.totalTokens - leftTotals.totalTokens ||
        rightTotals.cost - leftTotals.cost ||
        leftModel.localeCompare(rightModel),
    )
    .map(([model, totals]) => modelData(model, totals));
}

function periodData(
  snapshot: StatsSnapshot,
  start: number,
  end: number,
): StatsHtmlPeriod {
  const models = new Map<string, UsageTotals>();
  const total = { totalTokens: 0, cost: 0 };

  for (const [timestamp, modelTotals] of snapshot.byTimestamp) {
    if (timestamp < start || timestamp > end) continue;
    for (const [model, value] of modelTotals) {
      total.totalTokens += value.totalTokens;
      total.cost += value.cost;
      const modelTotal = models.get(model) ?? { totalTokens: 0, cost: 0 };
      modelTotal.totalTokens += value.totalTokens;
      modelTotal.cost += value.cost;
      models.set(model, modelTotal);
    }
  }

  return { total, models: sortModelTotals(models) };
}

function allTimePeriod(
  snapshot: StatsSnapshot,
  models: StatsHtmlModel[],
): StatsHtmlPeriod {
  return { total: { ...snapshot.total }, models };
}

export function serializeStatsSnapshot(
  snapshot: StatsSnapshot,
  generatedAt = new Date(),
): StatsHtmlData {
  const models = modelKeys(snapshot).map((model) =>
    modelData(
      model,
      snapshot.byModel.get(model) ?? { totalTokens: 0, cost: 0 },
    ),
  );
  const dates = [...snapshot.byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, modelTotals]) => ({
      day,
      models: [...modelTotals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, totals]) => modelData(model, totals)),
    }));

  const end = generatedAt.getTime();
  const day = 24 * 60 * 60 * 1000;

  return {
    generatedAt: generatedAt.toISOString(),
    total: { ...snapshot.total },
    models,
    dates,
    periods: {
      total: allTimePeriod(snapshot, models),
      last30Days: periodData(snapshot, end - 30 * day, end),
      last24Hours: periodData(snapshot, end - day, end),
    },
  };
}

function escapeJsonForHtml(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderStatsHtml(
  snapshot: StatsSnapshot,
  generatedAt = new Date(),
): string {
  const data = escapeJsonForHtml(
    JSON.stringify(serializeStatsSnapshot(snapshot, generatedAt)),
  );
  const template = readFileSync(TEMPLATE_URL, "utf8");
  if (!template.includes(DATA_PLACEHOLDER)) {
    throw new Error("Stats HTML template is missing its data placeholder");
  }
  return template.replace(DATA_PLACEHOLDER, data);
}

export async function writeStatsHtmlSnapshot(
  snapshot: StatsSnapshot,
  generatedAt = new Date(),
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-stats-"));
  const filePath = path.join(directory, "stats.html");
  try {
    await writeFile(filePath, renderStatsHtml(snapshot, generatedAt), {
      encoding: "utf8",
      mode: 0o600,
    });
    return filePath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function openBrowser(target: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];

  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

export async function openStatsHtml(snapshot: StatsSnapshot): Promise<string> {
  const filePath = await writeStatsHtmlSnapshot(snapshot);
  openBrowser(filePath);
  return filePath;
}
