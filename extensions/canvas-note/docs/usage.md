# 使用

## /canvas-note <msg>

```text
/canvas-note 分析当前项目架构，并绘制模块关系图
/canvas-note 将刚才的方案整理为交互文档
/canvas-note 修改报告中的代码示例
```

模板接收完整请求，将主要结果呈现在 Canvas Note 文档中；修改时优先更新已有 Block。不带参数时先询问需求。运行 `/reload` 后可在命令补全中选择 `/canvas-note`；模板使用已启用的 Canvas Note 工具。

## /canvas-note-server

```text
/canvas-note-server
```

命令启动或复用当前会话的画布服务，URL 只显示在状态栏；启动失败时显示错误通知。恢复会话后打开原文档，空会话展示空画布，首次插入内容时保存文档。命令直接启动服务，不调用模型或打开浏览器。关闭服务仍使用网页按钮或关闭最后一个网页。

## 创建报告

```js
const { pageId } = await tools.insert_page({ title: "销售分析" });
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

`insert_page` 返回页 ID 并设为当前页，创建空页不启动服务。`insert_blocks` 返回页 ID、Block ID 数组、浏览器地址、文档路径和版本。

| 参数 | 说明 |
|---|---|
| `pageId` | 目标页；省略使用当前页，没有页时创建“输出”页 |
| `index` | 从 0 开始，在该位置之前插入；省略或超过末尾时追加 |
| `blocks` | 非空数组，单个内容也使用数组 |
| `type` | `text`、`chart`、`math`、`table`、`divider`、`code` |
| `title` | 可选目录标题；省略时目录显示 Block 类型 |
| `align` | `left`（默认）、`center`、`right` |
| `spec` | text 为 `{md}`；chart 为 ECharts option；math 为 `{latex}`；table 为 `{columns: string[], rows: unknown[][]}`；divider 为 `{}`；code 为 `{code: string, language?: string}` |

工具调用按顺序执行；跨页组合调用时显式传入 `pageId`。图表配置使用纯 JSON。默认主题采用适配 Gruvbox 的暖色调色板，标题、图例、坐标轴和提示框跟随页面配色；显式指定的图表样式覆盖主题默认值，主题不写入文档或复制的配置。

工具落盘后推送创建、插入、更新或删除操作，网页直接更新对应页面和内容块；未涉及的图表和选择保持原样。首次连接、重连、版本不连续或外部文件修改时同步完整文档。工具返回不等待浏览器完成渲染。

## 目录与大纲

左侧默认显示“Outline”正文标题大纲，按页分组；点击“Structure”查看页与 Block 的结构目录。静态 HTML 恢复导出时保存的目录模式。点击条目跳转正文，点击箭头折叠子层级，点击“Collapse all / Expand all”单按钮切换当前目录所有层级的折叠与展开（离线 HTML 保留相同操作）；切换视图保留正文、选择和图表状态。

大纲提取文字中的 Markdown 标题（`#`～`######` 与下划线式标题），按页内正文顺序跨 Block 组织层级；重复标题分别定位，跳级标题挂到最近的较低级标题下。空页保留页条目。两种目录均由文档派生并只保存在浏览器内存，不写入文档文件。

## Markdown 公式

```js
await tools.insert_blocks({ blocks: [
  { type: "text", spec: { md: String.raw`能量$E=mc^2$。` } },
  { type: "text", spec: { md: "$$\n" + String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}` + "\n$$" } }
] });
```

Markdown 使用 `$...$` 渲染行内公式，使用 `$$...$$` 渲染展示公式；多行公式的起止 `$$` 各占一行。公式可紧邻中文，行内代码和围栏代码保持原文。普通美元符号写成 `\$`，例如 `\$5`。公式渲染结果随 PDF 和单文件 HTML 一起导出。

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

## 重命名与删除页

```js
await tools.update_page({ pageId: "<Page ID>", change: { kind: "rename", title: "新的标题" } });
await tools.update_page({ pageId: "<另一个 Page ID>", change: { kind: "delete" } });
```

`pageId` 必须存在；`change` 按 `kind` 严格区分两个分支：`rename` 必须携带非空白且不同于原标题的 `title`；`delete` 删除整页及其全部 Block，只接受 `kind` 字段。额外字段、未知分支或缺少有效修改时报错，不写文件或增加版本。

返回 `pageId`、`deleted`、`documentPath` 和 `version`。重命名同步正文、目录和反馈中的页标题；删除清理对应选择和图表，不影响其他页。最后一页也可删除，文档保留为空。删除当前页后，下次省略 `pageId` 插入会创建“输出”页。

页修改只同步正在运行的服务，不启动或重启服务。

## 保存 PDF

点击顶部“Export → Save PDF”，在浏览器打印窗口选择“另存为 PDF”。PDF 与 HTML 共用现有页和 Block 勾选：没有选择时导出全部；有选择时导出完整所选页及单独所选 Block，重叠内容去重，保留原文档顺序、所属页标题和所选空页。导出保留勾选。PDF 复用当前正文，等待字体与范围内图片准备完成后打开打印窗口；浏览器打印快捷键采用同一范围。

纸面仅保留页面正文，隐藏工具栏、网页目录、选择框、复制按钮和弹窗。默认 A4、16mm 页边距、白底深色文字；每个语义页面从新纸页开始，长代码换行，长表格跨页重复表头。打印或取消后保留选择与目录折叠状态，图表在打印时使用深色文字与加深的系列颜色，打印或取消后恢复网页主题和尺寸。PDF 书签由浏览器的打印能力决定。

点击“Export → Save HTML”按相同范围下载单文件 HTML。文件内嵌所选文档的静态数据、样式、字体与渲染资源，离线打开使用同一套页面和渲染器生成正文、公式、代码、图表与目录。HTML 保留目录模式和对应条目的折叠状态，支持切换 Outline / Structure、内容跳转、全部展开或折叠及复制；隐藏工具栏与选择框，跳过连接、重连、回复、导出和关闭服务等在线事件。资源读取失败时菜单显示错误，修复资源后可重新导出。

## 复制内容

点击任意 Block 右上角的“Copy”，按钮显示“Copied”表示成功，“Copy failed”表示浏览器拒绝复制。复制不改变已选内容。

文字复制 Markdown 源文，代码复制原始代码，公式复制 LaTeX，图表复制 ECharts 配置 JSON，表格复制包含表头的制表符分隔文本，分隔线复制 `---`。复制始终使用当前内容，不包含按钮或高亮标签。

## 多选回复

勾选页左上角“Select page”针对整页反馈，或勾选 Block 左上角选择框针对具体内容反馈，再点击顶部“回复”。页独立选择，不改变页内 Block 的勾选状态；支持多页及与 Block 混选，同一页与其 Block 同时选中时保留两种范围。弹窗分别列出页和内容块，空页也可选择；点击“Clear”清空全部选择。

完整反馈包含 `requestId`、`version`、`reply` 和含完整快照的 `pages`、`blocks`，保存在与 `doc.json` 并列的 `feedback-<requestId>.json`；不适合作文件名的 `requestId` 使用其哈希。反馈文件作为笔记的一部分长期保留，交付、重载和关闭服务均不删除它。先原子保存反馈文件，再在 Pi 会话保存轻量引用，最后发送 `followUp`；持久化在向浏览器确认成功（ACK）前完成。

正常反馈与待交付恢复上下文均仅包含用户回复、`pageIds`、`blockIds`、`version`、`snapshotPath` 和 `documentPath`，不包含块正文。模型按需用 `read` 读取 `snapshotPath`；修改前检查当前 `documentPath`，避免按旧快照覆盖后续更改。Pi 会话负责去重、待交付记录与交付确认；推理暂不可用时在下次运行补交，只有消息正式进入上下文才确认交付。恢复旧会话中尚未交付的完整反馈时，先迁移为反馈文件与轻量引用，再补交。

内容在弹窗打开后更新时，提交被拒绝并保留输入；关闭弹窗、重新检查所选内容后重试。渲染失败回传 Pi，单次扩展生命周期最多触发三次自动修复。

## 管理服务

点击右上角“Close server”，在弹窗中点击“确认关闭”；点击“取消”保留服务。

关闭最后一个 Canvas Note 网页也会停止服务，服务等待 1.5 秒以允许刷新和重连；仍有其他网页连接时继续运行。关闭网页前使用浏览器原生确认，需要先与页面交互。

首次插入或更新内容启动服务。关闭服务保留 JSON 文档，再次插入或更新时重启；重新连接同步完整文档。服务在配置区间内选择空闲端口，默认 10000–20000；重启后以工具返回的新地址为准。区间全部占用时报错，已写入内容保留，按返回的 ID 更新而不是重复插入。
