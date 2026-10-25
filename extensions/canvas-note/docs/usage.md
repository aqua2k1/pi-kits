# 使用

## 创建报告

```js
const { pageId } = await tools.new_page({ title: "销售分析" });
const result = await tools.insert_blocks({
  pageId,
  blocks: [
    { type: "text", title: "结论", spec: { md: "## 结论\n**增长明显**，*仍需观察*。" } },
    { type: "chart", title: "月度趋势", spec: {
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
| `type` | `text`、`chart`、`math`、`table`、`divider`、`code` |
| `title` | 可选目录标题；省略时目录显示 Block 类型 |
| `align` | `left`（默认）、`center`、`right` |
| `spec` | text 为 `{md}`；chart 为 ECharts option；math 为 `{latex}`；table 为 `{columns: string[], rows: unknown[][]}`；divider 为 `{}`；code 为 `{code: string, language?: string}` |

工具调用按顺序执行；跨页组合调用时显式传入 `pageId`。图表配置使用纯 JSON。

工具落盘后推送创建、插入、更新或删除操作，网页直接更新对应页面和内容块；未涉及的图表和选择保持原样。首次连接、重连、版本不连续或外部文件修改时同步完整文档。工具返回不等待浏览器完成渲染。

## 展示代码

```js
const { blockIds } = await tools.insert_blocks({ blocks: [
  { type: "code", title: "示例", spec: { code: "const answer = 42;", language: "javascript" } },
  { type: "code", spec: { code: "<自定义内容>", language: "unknown-language" } },
  { type: "code", spec: { code: "" } }
] });
await tools.update_blocks({ blocks: [
  { blockId: blockIds[0], spec: { code: "console.log(42);" } }
] });
```

`code` 必须是字符串，可为空；`language` 可省略或为任意字符串，包括空字符串和未知语言。显式指定本地高亮资源支持的语言时按 Gruvbox 配色高亮；省略、空或未知语言均显示纯文本，不自动猜测语言。高亮资源随扩展安装，浏览器无需访问 CDN。代码块只读展示，不执行代码，HTML 也作为代码文字显示。

示例更新整体替换 `spec`，因此移除原来的 `language`，改为纯文本展示；只传 `{language: "python"}` 会因缺少 `code` 使整批失败。

## 修改与删除

```js
await tools.update_blocks({ blocks: [
  { blockId: "<Block ID>", spec: { md: "修正后的完整文字" } },
  { blockId: "<另一个 Block ID>", type: null }
] });
```

省略字段保持不变，`title` 更新目录标题，传入 `title: null` 清除标题；`spec` 整体替换。改变 `type` 时同时提供新 `spec`；`type: null` 删除 Block。每批操作全成功或全失败。读取工具返回的文档路径可检查最新内容和 ID。

## 保存 PDF

点击顶部“Save PDF”，在浏览器打印窗口选择“另存为 PDF”。导出复用当前页面内容，等待字体与图片准备完成后打开打印窗口；也可直接使用浏览器打印快捷键。

纸面仅保留页面正文，隐藏工具栏、网页目录、选择框、复制按钮和弹窗。默认 A4、16mm 页边距、白底深色文字；每个语义页面从新纸页开始，长代码换行，长表格跨页重复表头。打印或取消后保留选择与目录折叠状态，图表恢复网页尺寸。PDF 书签由浏览器的打印能力决定。

## 复制内容

点击任意 Block 右上角的“Copy”，按钮显示“Copied”表示成功，“Copy failed”表示浏览器拒绝复制。复制不改变已选内容。

文字复制 Markdown 源文，代码复制原始代码，公式复制 LaTeX，图表复制 ECharts 配置 JSON，表格复制包含表头的制表符分隔文本，分隔线复制 `---`。复制始终使用当前内容，不包含按钮或高亮标签。

## 多选回复

勾选每个 Block 左上角选择框，跨页选择内容后点击顶部“回复”。弹窗中的一次回复引用全部所选内容。

完整反馈包含 `requestId`、`version`、`reply` 和含完整快照的 `blocks`，保存在与 `doc.json` 并列的 `feedback-<requestId>.json`；不适合作文件名的 `requestId` 使用其哈希。反馈文件作为笔记的一部分长期保留，交付、重载和关闭服务均不删除它。先原子保存反馈文件，再在 Pi 会话保存轻量引用，最后发送 `followUp`；持久化在向浏览器确认成功（ACK）前完成。

正常反馈与待交付恢复上下文均仅包含用户回复、`blockIds`、`version`、`snapshotPath` 和 `documentPath`，不包含块正文。模型按需用 `read` 读取 `snapshotPath`；修改前检查当前 `documentPath`，避免按旧快照覆盖后续更改。Pi 会话负责去重、待交付记录与交付确认；推理暂不可用时在下次运行补交，只有消息正式进入上下文才确认交付。恢复旧会话中尚未交付的完整反馈时，先迁移为反馈文件与轻量引用，再补交。

内容在弹窗打开后更新时，提交被拒绝并保留输入；关闭弹窗、重新检查所选内容后重试。渲染失败回传 Pi，单次扩展生命周期最多触发三次自动修复。

## 管理服务

点击右上角“Close server”，在弹窗中点击“确认关闭”；点击“取消”保留服务。

关闭最后一个 Canvas Note 网页也会停止服务，服务等待 1.5 秒以允许刷新和重连；仍有其他网页连接时继续运行。关闭网页前使用浏览器原生确认，需要先与页面交互。

首次插入或更新内容启动服务。关闭服务保留 JSON 文档，再次插入或更新时重启；重新连接同步完整文档。服务在配置区间内选择空闲端口，默认 10000–20000；重启后以工具返回的新地址为准。区间全部占用时报错，已写入内容保留，按返回的 ID 更新而不是重复插入。
