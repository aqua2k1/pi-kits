# 使用

## 创建报告

```js
const { pageId } = await tools.new_page({ title: "销售分析" });
const result = await tools.insert_blocks({
  pageId,
  blocks: [
    { type: "text", spec: { md: "## 结论\n**增长明显**，*仍需观察*。" } },
    { type: "chart", spec: {
      xAxis: { type: "category", data: ["一月", "二月"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: [120, 180] }]
    } },
    { type: "math", align: "center", spec: { latex: "y=x^2" } }
  ]
});
```

`new_page` 返回页 ID 并设为当前页，创建空页不启动服务。`insert_blocks` 返回页 ID、Block ID 数组、浏览器地址、文档路径和版本。

| 参数 | 说明 |
|---|---|
| `pageId` | 目标页；省略使用当前页，没有页时创建“输出”页 |
| `index` | 从 0 开始，在该位置之前插入；省略或超过末尾时追加 |
| `blocks` | 非空数组，单个内容也使用数组 |
| `type` | `text`、`chart`、`math`、`table`、`divider` |
| `align` | `left`（默认）、`center`、`right` |
| `spec` | text 为 `{md}`；chart 为 ECharts option；math 为 `{latex}`；table 为 `{columns: string[], rows: unknown[][]}`；divider 为 `{}` |

工具调用按顺序执行；跨页组合调用时显式传入 `pageId`。图表配置使用纯 JSON。

## 修改与删除

```js
await tools.update_blocks({ blocks: [
  { blockId: "<Block ID>", spec: { md: "修正后的完整文字" } },
  { blockId: "<另一个 Block ID>", type: null }
] });
```

省略字段保持不变，`spec` 整体替换。改变 `type` 时同时提供新 `spec`；`type: null` 删除 Block。每批操作全成功或全失败。读取工具返回的文档路径可检查最新内容和 ID。

## 多选回复

勾选每个 Block 左上角选择框，跨页选择内容后点击顶部“回复”。弹窗中的一次回复引用全部所选内容，Pi 收到内容快照、Block ID 和版本后继续处理。

回复在确认成功前写入 Pi 会话；推理暂不可用时保留待交付记录，在下次运行补交。内容在弹窗打开后更新时，提交被拒绝并保留输入；关闭弹窗、重新检查所选内容后重试。渲染失败回传 Pi，单次扩展生命周期最多触发三次自动修复。

## 管理服务

点击右上角“Close server”，在弹窗中点击“确认关闭”；点击“取消”保留服务。

关闭最后一个 Canvas Note 网页也会停止服务，服务等待 1.5 秒以允许刷新和重连；仍有其他网页连接时继续运行。关闭网页前使用浏览器原生确认，需要先与页面交互。

首次插入或更新内容启动服务。关闭服务保留 JSON 文档，再次插入或更新时重启；重新连接同步完整文档。服务在配置区间内选择空闲端口，默认 10000–20000；重启后以工具返回的新地址为准。区间全部占用时报错，已写入内容保留，按返回的 ID 更新而不是重复插入。
