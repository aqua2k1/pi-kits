import {
  dateKey,
  modelKeys,
  type StatsSnapshot,
  type UsageTotals,
} from "./core.ts";

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

export interface StatsReport extends StatsHtmlData {
  calendar: {
    today: string;
    month: string;
    todayTokens: number;
    monthTokens: number;
    years: number[];
    byDate: Record<string, number>;
    totalsByDate: Record<string, UsageTotals>;
  };
}

export function buildStatsReport(
  snapshot: StatsSnapshot,
  generatedAt = new Date(),
): StatsReport {
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

  const today = dateKey(generatedAt.getTime());
  if (!today) throw new RangeError("Invalid report date");
  const month = today.slice(0, 7);
  const byDate: Record<string, number> = {};
  const totalsByDate: Record<string, UsageTotals> = {};
  let monthTokens = 0;
  const years = new Set([generatedAt.getFullYear()]);
  for (const { day, models: dayModels } of dates) {
    const totals = { totalTokens: 0, cost: 0 };
    for (const model of dayModels) {
      totals.totalTokens += model.totalTokens;
      totals.cost += model.cost;
    }
    const tokens = totals.totalTokens;
    byDate[day] = tokens;
    totalsByDate[day] = totals;
    if (day.startsWith(month)) monthTokens += tokens;
    years.add(Number(day.slice(0, 4)));
  }

  const end = generatedAt.getTime();
  const day = 24 * 60 * 60 * 1000;

  return {
    generatedAt: generatedAt.toISOString(),
    calendar: {
      today,
      month,
      todayTokens: byDate[today] ?? 0,
      monthTokens,
      years: [...years].sort((a, b) => a - b),
      byDate,
      totalsByDate,
    },
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
