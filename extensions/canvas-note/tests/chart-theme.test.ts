import assert from "node:assert/strict";
import test from "node:test";
import { type EChartsOption, init, version } from "echarts";
import { createChartTheme } from "../web/chart-theme.js";

const palettes = {
  screen: [
    "#458c6b",
    "#f2da87",
    "#d9a86c",
    "#d94436",
    "#fb4934",
    "#76bc9b",
    "#cce6da",
    "#eeeeee",
  ],
  print: [
    "#458c6b",
    "#b57614",
    "#af7041",
    "#cc241d",
    "#d65d0e",
    "#427b58",
    "#076678",
    "#665c54",
  ],
};

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function objects(value: unknown, result = new Set<object>()): Set<object> {
  if (value && typeof value === "object" && !result.has(value)) {
    result.add(value);
    for (const child of Object.values(value)) objects(child, result);
  }
  return result;
}

for (const mode of ["screen", "print"] as const) {
  test(`${mode}: palette and semantic fallbacks are complete`, () => {
    const theme = createChartTheme({}, mode);
    const [text, muted, border, surface, background] =
      mode === "screen"
        ? ["#ebdbb2", "#a89984", "#665c54", "#282828", "#1d2021"]
        : ["#222", "#555", "#aaa", "#fff", "#fff"];
    assert.deepEqual(theme.color, palettes[mode]);
    assert.equal(theme.backgroundColor, "transparent");
    assert.equal(theme.textStyle.color, text);
    assert.equal(theme.title.textStyle.color, text);
    assert.equal(theme.title.subtextStyle.color, muted);
    assert.equal(theme.legend.textStyle.color, text);
    assert.equal(theme.legend.inactiveColor, muted);
    assert.equal(theme.tooltip.backgroundColor, surface);
    assert.equal(theme.tooltip.borderColor, border);
    assert.equal(theme.tooltip.textStyle.color, text);
    assert.equal(theme.tooltip.axisPointer.lineStyle.color, muted);
    assert.equal(theme.axisPointer.label.backgroundColor, surface);
    assert.equal(theme.toolbox.iconStyle.borderColor, muted);
    assert.equal(theme.dataZoom.backgroundColor, background);
    assert.equal(theme.dataZoom.handleStyle.color, surface);
    assert.equal(theme.timeline.label.color, muted);
    assert.equal(theme.timeline.lineStyle.color, border);
    assert.equal(theme.radar.axisName.color, text);
    assert.equal(theme.pie.itemStyle.borderColor, background);
    assert.equal(theme.pie.label.color, text);
    assert.equal(Object.hasOwn(theme.pie.label, "show"), false);
    for (const axis of [
      theme.timeAxis,
      theme.logAxis,
      theme.valueAxis,
      theme.categoryAxis,
    ]) {
      assert.equal(axis.axisLabel.color, muted);
      assert.equal(axis.nameTextStyle.color, text);
      assert.equal(axis.axisLine.lineStyle.color, border);
      assert.equal(axis.axisTick.lineStyle.color, border);
      assert.deepEqual(axis.splitLine.lineStyle, {
        color: border,
        opacity: mode === "screen" ? 0.35 : 0.4,
      });
      assert.deepEqual(axis.splitArea.areaStyle.color, [surface, background]);
    }
    assert.equal(JSON.stringify(theme).includes("color-mix"), false);
    assert.equal(
      createChartTheme({ text: "#123456" }, mode).textStyle.color,
      "#123456",
    );
    assert.equal(
      createChartTheme({ text: "#123456" }, mode).tooltip.borderColor,
      border,
    );
  });
}

test("CSS colors take precedence without mutation; mode does not change layout", () => {
  const colors = freezeDeep({
    text: "#112233",
    muted: "#445566",
    border: "#778899",
    surface: "#aabbcc",
    background: "#ddeeff",
  });
  const before = structuredClone(colors);
  const screen = createChartTheme(colors);
  const print = createChartTheme(colors, "print");
  assert.deepEqual(colors, before);
  assert.equal(screen.title.textStyle.color, colors.text);
  assert.equal(screen.legend.inactiveColor, colors.muted);
  assert.equal(screen.valueAxis.axisLine.lineStyle.color, colors.border);
  assert.equal(screen.tooltip.backgroundColor, colors.surface);
  assert.equal(screen.pie.itemStyle.borderColor, colors.background);
  // Only palette and split-line opacity differ when all semantic colors exist.
  print.color = [...screen.color];
  for (const key of [
    "timeAxis",
    "logAxis",
    "valueAxis",
    "categoryAxis",
    "radar",
  ] as const) {
    print[key].splitLine.lineStyle.opacity =
      screen[key].splitLine.lineStyle.opacity;
  }
  assert.deepEqual(print, screen);
  assert.deepEqual(createChartTheme({}), createChartTheme({}, "screen"));
});

test("calls and sibling components have no shared mutable state", () => {
  const first = createChartTheme({});
  const snapshot = structuredClone(first);
  for (const mode of ["screen", "print"] as const) {
    const next = createChartTheme({}, mode);
    const firstObjects = objects(first);
    for (const value of objects(next))
      assert.equal(firstObjects.has(value), false);
    next.color[0] = "red";
    next.tooltip.textStyle.color = "blue";
    next.valueAxis.splitLine.lineStyle.color = "green";
    assert.deepEqual(first, snapshot);
  }
  first.valueAxis.splitArea.areaStyle.color.push("red");
  assert.deepEqual(first.categoryAxis.splitArea.areaStyle.color, [
    "#282828",
    "#1d2021",
  ]);
});

test("ECharts 6 SVG SSR preserves user spec and applies defaults on setTheme", () => {
  assert.equal(Number(version.split(".")[0]), 6);
  const spec: EChartsOption = freezeDeep({
    animation: false,
    title: { text: "Title", textStyle: { color: "#123456" } },
    tooltip: { textStyle: { color: "#345678" } },
    legend: {},
    xAxis: {
      type: "category",
      data: ["A", "B"],
      axisLabel: { color: "#234567" },
    },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        name: "Explicit",
        data: [1, 2],
        itemStyle: { color: "#abcdef" },
      },
      { type: "bar", name: "Default", data: [2, 3] },
      { type: "bar", name: "Default second", data: [3, 4] },
    ],
  });
  const before = structuredClone(spec);
  const screen = freezeDeep(createChartTheme({}));
  const print = freezeDeep(createChartTheme({}, "print"));
  const chart = init(null, screen, {
    renderer: "svg",
    ssr: true,
    width: 600,
    height: 400,
  });
  try {
    chart.setOption(spec);
    for (const [mode, theme] of [
      ["screen", screen],
      ["print", print],
      ["screen", screen],
    ] as const) {
      chart.setTheme(theme);
      const svg = chart.renderToSVGString();
      assert.match(svg, /<svg/);
      assert.ok(svg.includes("#abcdef"), "explicit series color survives");
      assert.ok(svg.includes("#123456"), "explicit title color survives");
      assert.ok(svg.includes("#234567"), "explicit axis label color survives");
      assert.ok(
        svg.includes(palettes[mode][1]),
        "unspecified series uses current palette",
      );
      assert.ok(
        svg.includes(theme.textStyle.color),
        "unspecified text uses current theme",
      );
      assert.ok(
        !svg.includes(palettes[mode === "screen" ? "print" : "screen"][1]),
      );
      const option = chart.getOption();
      assert.equal(
        (option.tooltip as { textStyle: { color: string } }[])[0].textStyle
          .color,
        "#345678",
      );
      assert.deepEqual(
        spec,
        before,
        "setOption/setTheme must not contaminate source spec",
      );
      assert.deepEqual(screen, createChartTheme({}));
      assert.deepEqual(print, createChartTheme({}, "print"));
    }
  } finally {
    chart.dispose();
  }
});
