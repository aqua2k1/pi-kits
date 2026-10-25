// @ts-check

/**
 * Build fresh ECharts defaults without reading CSS or modifying chart options.
 * Semantic colors are resolved by the caller from CSS variables; mode only
 * selects palette/fallback colors, never chart layout or visibility.
 * @param {Record<string, string>} colors
 * @param {'screen' | 'print'} [mode='screen']
 */
export function createChartTheme(colors, mode = "screen") {
  const print = mode === "print";
  const text = colors.text ?? (print ? "#222" : "#ebdbb2");
  const muted = colors.muted ?? (print ? "#555" : "#a89984");
  const border = colors.border ?? (print ? "#aaa" : "#665c54");
  const surface = colors.surface ?? (print ? "#fff" : "#282828");
  const background = colors.background ?? (print ? "#fff" : "#1d2021");
  const color = print
    ? [
        "#458c6b",
        "#b57614",
        "#af7041",
        "#cc241d",
        "#d65d0e",
        "#427b58",
        "#076678",
        "#665c54",
      ]
    : [
        "#458c6b",
        "#f2da87",
        "#d9a86c",
        "#d94436",
        "#fb4934",
        "#76bc9b",
        "#cce6da",
        "#eeeeee",
      ];
  const axis = () => ({
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: muted },
    nameTextStyle: { color: text },
    splitLine: { lineStyle: { color: border, opacity: print ? 0.4 : 0.35 } },
    minorSplitLine: { lineStyle: { color: border, opacity: 0.2 } },
    splitArea: { areaStyle: { color: [surface, background] } },
  });
  const pointer = () => ({
    lineStyle: { color: muted },
    crossStyle: { color: muted, textStyle: { color: text } },
    shadowStyle: { color: border, opacity: 0.2 },
    label: { color: text, backgroundColor: surface, borderColor: border },
  });

  return {
    color,
    backgroundColor: "transparent",
    textStyle: { color: text },
    title: {
      textStyle: { color: text },
      subtextStyle: { color: muted },
    },
    legend: {
      textStyle: { color: text },
      inactiveColor: muted,
      inactiveBorderColor: border,
      pageTextStyle: { color: muted },
    },
    timeAxis: axis(),
    logAxis: axis(),
    valueAxis: axis(),
    categoryAxis: axis(),
    axisPointer: pointer(),
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: text },
      axisPointer: pointer(),
    },
    toolbox: {
      iconStyle: { borderColor: muted },
      emphasis: { iconStyle: { borderColor: text } },
    },
    dataZoom: {
      backgroundColor: background,
      borderColor: border,
      textStyle: { color: muted },
      fillerColor: surface,
      handleStyle: { color: surface, borderColor: muted },
      moveHandleStyle: { color: muted },
      dataBackground: {
        lineStyle: { color: border },
        areaStyle: { color: border, opacity: 0.2 },
      },
      selectedDataBackground: {
        lineStyle: { color: text },
        areaStyle: { color: muted, opacity: 0.3 },
      },
      emphasis: {
        handleStyle: { color: surface, borderColor: text },
        moveHandleStyle: { color: text },
      },
    },
    timeline: {
      lineStyle: { color: border },
      itemStyle: { color: muted },
      label: { color: muted },
      controlStyle: { color: muted, borderColor: muted },
      checkpointStyle: { color: text, borderColor: surface },
      progress: {
        lineStyle: { color: text },
        itemStyle: { color: text },
        label: { color: text },
      },
      emphasis: {
        label: { color: text },
        controlStyle: { color: text, borderColor: text },
      },
    },
    radar: {
      axisName: { color: text },
      axisLine: { lineStyle: { color: border } },
      splitLine: { lineStyle: { color: border, opacity: print ? 0.4 : 0.35 } },
      splitArea: { areaStyle: { color: [surface, background] } },
    },
    pie: {
      itemStyle: { borderColor: background },
      label: { color: text },
      labelLine: { lineStyle: { color: muted } },
    },
    visualMap: { textStyle: { color: text } },
  };
}
