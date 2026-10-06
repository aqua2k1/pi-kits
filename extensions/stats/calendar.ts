import { dateKey, type UsageTotals } from "./core.ts";

export interface CalendarDay {
  key: string;
  month: number;
  date: number;
  weekday: number;
  week: number;
  index: number;
  tokens: number;
  cost: number;
  level: number;
}

export interface YearCalendar {
  year: number;
  days: CalendarDay[];
  weeks: (CalendarDay | undefined)[][];
}

export interface CalendarUsage {
  byDate: Record<string, number>;
  totalsByDate: Record<string, UsageTotals>;
}

/** Local noon avoids DST midnight transitions and Date's special years 0–99. */
function localDate(year: number): Date {
  const date = new Date(0);
  date.setFullYear(year, 0, 1);
  date.setHours(12, 0, 0, 0);
  return date;
}

/** Sunday-first annual grid, including both partial weeks (53 or 54 columns). */
export function buildYearCalendar(
  usage: CalendarUsage,
  year: number,
): YearCalendar {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError("Calendar year must be an integer from 1 to 9999");
  }
  const weeks: YearCalendar["weeks"] = [];
  const days: CalendarDay[] = [];
  const date = localDate(year);
  let maximum = 0;
  while (date.getFullYear() === year) {
    if (!weeks.length || date.getDay() === 0) {
      weeks.push(Array<CalendarDay | undefined>(7).fill(undefined));
    }
    const key = dateKey(date.getTime());
    if (!key) throw new RangeError("Invalid calendar date");
    const tokens = usage.byDate[key] ?? 0;
    maximum = Math.max(maximum, tokens);
    const day: CalendarDay = {
      key,
      month: date.getMonth(),
      date: date.getDate(),
      weekday: date.getDay(),
      week: weeks.length - 1,
      index: days.length,
      tokens,
      cost: usage.totalsByDate[key]?.cost ?? 0,
      level: 0,
    };
    days.push(day);
    weeks[day.week][day.weekday] = day;
    date.setDate(date.getDate() + 1);
  }
  for (const day of days) {
    day.level =
      day.tokens > 0 ? Math.max(1, Math.ceil((day.tokens / maximum) * 4)) : 0;
  }
  return { year, days, weeks };
}
