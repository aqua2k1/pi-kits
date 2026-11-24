export interface ToolRule {
  readonly tool: Readonly<Record<string, unknown>>;
  readonly match: (item: Record<string, unknown>) => boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function appendUnique(
  existing: unknown,
  rules: readonly ToolRule[],
): readonly unknown[] | undefined {
  const current = Array.isArray(existing) ? existing : [];
  const additions = rules
    .filter(
      (rule) => !current.some((item) => isRecord(item) && rule.match(item)),
    )
    .map((rule) => rule.tool);
  return additions.length > 0 ? [...current, ...additions] : undefined;
}
