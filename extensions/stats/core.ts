import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const ALL_MODELS = "__all__";
export const OTHER_MODEL = "Tools/summaries";
export const UNKNOWN_MODEL = "Unknown model";

export interface UsageTotals {
  totalTokens: number;
  cost: number;
}

export interface StatsSnapshot {
  byDate: Map<string, Map<string, UsageTotals>>;
  byTimestamp: Map<number, Map<string, UsageTotals>>;
  byModel: Map<string, UsageTotals>;
  total: UsageTotals;
  filesScanned: number;
  sessionsScanned: number;
  usageEntries: number;
  malformedLines: number;
  failedFiles: number;
}

interface RecordValue {
  [key: string]: unknown;
}

interface UsageValue extends RecordValue {
  cost?: RecordValue;
}

interface UsageContribution {
  model: string;
  usage: UsageValue;
  timestamp: unknown;
}

export type ScanProgress = (completed: number, total: number) => void;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function asUsage(value: unknown): UsageValue | undefined {
  return isRecord(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usageTotal(usage: UsageValue): UsageTotals {
  const cost = asRecord(usage.cost);
  return {
    totalTokens:
      nonNegativeNumber(usage.input) +
      nonNegativeNumber(usage.output) +
      nonNegativeNumber(usage.cacheRead) +
      nonNegativeNumber(usage.cacheWrite),
    cost: nonNegativeNumber(cost?.total),
  };
}

function hasUsage(total: UsageTotals): boolean {
  return total.totalTokens > 0 || total.cost > 0;
}

function usageDedupKey(
  entry: RecordValue,
  contribution: UsageContribution,
): string {
  const usage = contribution.usage;
  const cost = asRecord(usage.cost);
  return JSON.stringify([
    entry.id,
    entry.type,
    entry.parentId,
    entry.timestamp,
    contribution.model,
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    cost?.input,
    cost?.output,
    cost?.cacheRead,
    cost?.cacheWrite,
    cost?.total,
  ]);
}

function addTotals(target: UsageTotals, addition: UsageTotals): void {
  target.totalTokens += addition.totalTokens;
  target.cost += addition.cost;
}

function modelKey(message: RecordValue): string {
  const provider = stringValue(message.provider);
  const model =
    stringValue(message.responseModel) ?? stringValue(message.model);
  if (provider && model) return `${provider}/${model}`;
  return UNKNOWN_MODEL;
}

function contributionForEntry(
  entry: RecordValue,
): UsageContribution | undefined {
  if (entry.type === "message") {
    const message = asRecord(entry.message);
    if (!message) return undefined;

    if (message.role === "assistant") {
      const usage = asUsage(message.usage);
      if (!usage) return undefined;
      return {
        model: modelKey(message),
        usage,
        timestamp: entry.timestamp ?? message.timestamp,
      };
    }

    if (message.role === "toolResult") {
      const usage = asUsage(message.usage);
      if (!usage) return undefined;
      return {
        model: OTHER_MODEL,
        usage,
        timestamp: entry.timestamp ?? message.timestamp,
      };
    }

    return undefined;
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const usage = asUsage(entry.usage);
    if (!usage) return undefined;
    return { model: OTHER_MODEL, usage, timestamp: entry.timestamp };
  }

  return undefined;
}

export function createStatsSnapshot(): StatsSnapshot {
  return {
    byDate: new Map(),
    byTimestamp: new Map(),
    byModel: new Map(),
    total: { totalTokens: 0, cost: 0 },
    filesScanned: 0,
    sessionsScanned: 0,
    usageEntries: 0,
    malformedLines: 0,
    failedFiles: 0,
  };
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function dateKey(value: unknown): string | undefined {
  const timestamp = timestampValue(value);
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Add one parsed session entry, returning true when it contributed usage. */
export function addSessionEntry(
  snapshot: StatsSnapshot,
  entry: unknown,
  seenEntryKeys?: Set<string>,
): boolean {
  const record = asRecord(entry);
  if (!record || record.type === "session") return false;

  const id = stringValue(record.id);
  const contribution = contributionForEntry(record);
  if (!contribution) return false;

  const total = usageTotal(contribution.usage);
  if (!hasUsage(total)) return false;

  const dedupKey = id ? usageDedupKey(record, contribution) : undefined;
  if (dedupKey && seenEntryKeys?.has(dedupKey)) return false;
  if (dedupKey) seenEntryKeys?.add(dedupKey);

  const modelTotals = snapshot.byModel.get(contribution.model) ?? {
    totalTokens: 0,
    cost: 0,
  };
  addTotals(modelTotals, total);
  snapshot.byModel.set(contribution.model, modelTotals);
  addTotals(snapshot.total, total);

  const timestamp = timestampValue(contribution.timestamp);
  if (timestamp !== undefined) {
    const modelByTimestamp =
      snapshot.byTimestamp.get(timestamp) ?? new Map<string, UsageTotals>();
    const timestampTotals = modelByTimestamp.get(contribution.model) ?? {
      totalTokens: 0,
      cost: 0,
    };
    addTotals(timestampTotals, total);
    modelByTimestamp.set(contribution.model, timestampTotals);
    snapshot.byTimestamp.set(timestamp, modelByTimestamp);

    const day = dateKey(timestamp);
    if (day) {
      const modelByDay =
        snapshot.byDate.get(day) ?? new Map<string, UsageTotals>();
      const dayTotals = modelByDay.get(contribution.model) ?? {
        totalTokens: 0,
        cost: 0,
      };
      addTotals(dayTotals, total);
      modelByDay.set(contribution.model, dayTotals);
      snapshot.byDate.set(day, modelByDay);
    }
  }

  snapshot.usageEntries++;
  return true;
}

export function aggregateEntries(entries: Iterable<unknown>): StatsSnapshot {
  const snapshot = createStatsSnapshot();
  const seenEntryKeys = new Set<string>();

  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.type === "session") snapshot.sessionsScanned++;
    addSessionEntry(snapshot, entry, seenEntryKeys);
  }

  return snapshot;
}

async function scanSessionFile(
  filePath: string,
  snapshot: StatsSnapshot,
  seenEntryKeys: Set<string>,
): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let headerSeen = false;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        snapshot.malformedLines++;
        continue;
      }

      const record = asRecord(parsed);
      if (!record) continue;

      if (!headerSeen) {
        if (record.type !== "session") return;
        headerSeen = true;
        snapshot.sessionsScanned++;
        continue;
      }

      addSessionEntry(snapshot, record, seenEntryKeys);
    }
  } finally {
    lines.close();
  }
}

export async function findSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files.sort();
}

export async function scanSessionFiles(
  files: readonly string[],
  onProgress?: ScanProgress,
): Promise<StatsSnapshot> {
  const snapshot = createStatsSnapshot();
  const seenEntryKeys = new Set<string>();

  for (const [index, filePath] of files.entries()) {
    try {
      await scanSessionFile(filePath, snapshot, seenEntryKeys);
      snapshot.filesScanned++;
    } catch {
      snapshot.failedFiles++;
    }
    onProgress?.(index + 1, files.length);
  }

  return snapshot;
}

export function modelKeys(snapshot: StatsSnapshot): string[] {
  return [...snapshot.byModel.keys()].sort((a, b) => {
    const aTotals = snapshot.byModel.get(a) ?? { totalTokens: 0, cost: 0 };
    const bTotals = snapshot.byModel.get(b) ?? { totalTokens: 0, cost: 0 };
    return (
      bTotals.totalTokens - aTotals.totalTokens ||
      bTotals.cost - aTotals.cost ||
      a.localeCompare(b)
    );
  });
}

export function totalsForModel(
  snapshot: StatsSnapshot,
  model: string,
): UsageTotals {
  if (model === ALL_MODELS) return snapshot.total;
  return snapshot.byModel.get(model) ?? { totalTokens: 0, cost: 0 };
}

export function totalsForDate(
  snapshot: StatsSnapshot,
  day: string,
  model: string,
): UsageTotals {
  const modelByDay = snapshot.byDate.get(day);
  if (!modelByDay) return { totalTokens: 0, cost: 0 };
  if (model !== ALL_MODELS) {
    return modelByDay.get(model) ?? { totalTokens: 0, cost: 0 };
  }

  const total = { totalTokens: 0, cost: 0 };
  for (const value of modelByDay.values()) addTotals(total, value);
  return total;
}

export function totalsForTimeRange(
  snapshot: StatsSnapshot,
  start: number,
  end: number,
  model: string = ALL_MODELS,
): UsageTotals {
  const total = { totalTokens: 0, cost: 0 };
  for (const [timestamp, modelTotals] of snapshot.byTimestamp) {
    if (timestamp < start || timestamp > end) continue;
    if (model !== ALL_MODELS) {
      const value = modelTotals.get(model);
      if (value) addTotals(total, value);
      continue;
    }
    for (const value of modelTotals.values()) addTotals(total, value);
  }
  return total;
}
